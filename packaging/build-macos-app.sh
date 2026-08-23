#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_ROOT="/Users/majorjohn/Library/Application Support/HoshiStream"
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
/usr/libexec/PlistBuddy -c "Set :HoshiStreamProjectRoot $DATA_ROOT" "$CONTENTS/Info.plist"
cp "$ROOT/vendor/node/darwin-arm64/node" "$RUNTIME/bin/node"
cp "$ROOT/scripts/native-server.mjs" "$RUNTIME/scripts/native-server.mjs"
cp "$ROOT/scripts/lan-ip.mjs" "$RUNTIME/scripts/lan-ip.mjs"
cp "$ROOT/packaging/torrserver-settings.json" \
  "$RUNTIME/packaging/torrserver-settings.json"
cp -R "$ROOT/addon/dist" "$RUNTIME/addon/dist"
cp -R "$ROOT/addon/assets" "$RUNTIME/addon/assets"
cp -R "$ROOT/addon/node_modules" "$RUNTIME/addon/node_modules"
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
codesign --force --deep --sign - "$APP"
echo "$APP"
