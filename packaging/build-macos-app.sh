#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
node "$ROOT/packaging/macos-contract.mjs" vendor
BUILD_DIR="${HOSHISTREAM_BUILD_DIR:-$ROOT/build}"
mkdir -p "$BUILD_DIR"
BUILD_DIR=$(CDPATH= cd -- "$BUILD_DIR" && pwd)
APP="$BUILD_DIR/HoshiStream.app"
CONTENTS="$APP/Contents"
RUNTIME="$CONTENTS/Resources/runtime"
IDENTITY="$BUILD_DIR/release.json"

# Capture source state once, before compilation, and carry this exact stamp
# through the runtime, native bundle, and subsequent DMG packaging.
node "$ROOT/packaging/release-identity.mjs" create "$IDENTITY"
rm -rf "$BUILD_DIR/addon-dist"
(cd "$ROOT/addon" && npm run build -- --outDir "$BUILD_DIR/addon-dist")
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$RUNTIME/bin" "$RUNTIME/scripts" \
  "$RUNTIME/addon" "$RUNTIME/packaging" "$RUNTIME/vendor/torrserver/darwin-arm64" \
  "$RUNTIME/vendor/ffmpeg/darwin-arm64" "$RUNTIME/third-party"

# Prefer a full Xcode when present, otherwise fall back to the Command Line
# Tools, which carry an SDK sufficient for AppKit and ServiceManagement.
if [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  export DEVELOPER_DIR
fi

MIN_MACOS=$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" \
  "$ROOT/supervisor/macos/Info.plist")
xcrun swiftc -parse-as-library -target "arm64-apple-macos$MIN_MACOS" \
  -module-cache-path "$BUILD_DIR/swift-module-cache" \
  -framework AppKit \
  -framework ServiceManagement \
  "$ROOT/supervisor/macos/Sources/"*.swift \
  -o "$CONTENTS/MacOS/HoshiStream"

cp "$ROOT/supervisor/macos/Info.plist" "$CONTENTS/Info.plist"
release_field() {
  node "$ROOT/packaging/release-identity.mjs" field "$IDENTITY" "$1"
}
VERSION=$(release_field version)
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(release_field buildNumber)" "$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :HoshiStreamBuildID $(release_field buildId)" "$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :HoshiStreamRevision $(release_field revision)" "$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :HoshiStreamDirty $(release_field dirty)" "$CONTENTS/Info.plist"
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
cp "$ROOT/scripts/private-files.mjs" "$RUNTIME/scripts/private-files.mjs"
cp "$ROOT/scripts/native-runtime.mjs" "$RUNTIME/scripts/native-runtime.mjs"
cp "$ROOT/scripts/native-control.mjs" "$RUNTIME/scripts/native-control.mjs"
cp "$ROOT/scripts/lan-ip.mjs" "$RUNTIME/scripts/lan-ip.mjs"
cp "$ROOT/scripts/register-browser-bridge.mjs" "$RUNTIME/scripts/register-browser-bridge.mjs"
cp "$ROOT/packaging/torrserver-settings.json" \
  "$RUNTIME/packaging/torrserver-settings.json"
cp -R "$BUILD_DIR/addon-dist" "$RUNTIME/addon/dist"
cp -R "$ROOT/addon/assets" "$RUNTIME/addon/assets"
cp "$ROOT/addon/package.json" "$RUNTIME/addon/package.json"
cp "$ROOT/addon/package-lock.json" "$RUNTIME/addon/package-lock.json"
cp "$IDENTITY" "$RUNTIME/addon/release.json"
# Production-only dependencies. The checkout's node_modules carries the seven
# devDependencies (vitest, eslint, typescript, vite, ...) that nothing needs at
# runtime, and the UI is prebuilt into addon/assets, so shipping them only
# inflates the download. Install from the lockfile into a staging dir instead.
DEPS_STAGE="$BUILD_DIR/deps-stage"
mkdir -p "$DEPS_STAGE"
cp "$ROOT/addon/package.json" "$ROOT/addon/package-lock.json" "$DEPS_STAGE/"
(cd "$DEPS_STAGE" && npm ci --cache "$BUILD_DIR/macos-npm" --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
# Runtime imports never use npm's command-line symlinks.
rm -rf "$DEPS_STAGE/node_modules/.bin"
cp -R "$DEPS_STAGE/node_modules" "$RUNTIME/addon/node_modules"
cp "$ROOT/vendor/torrserver/darwin-arm64/TorrServer" \
  "$RUNTIME/vendor/torrserver/darwin-arm64/TorrServer"

# Source checks need both tools even when optional stream repair is disabled.
cp "$ROOT/vendor/ffmpeg/darwin-arm64/ffmpeg" \
  "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffmpeg"
cp "$ROOT/vendor/ffmpeg/darwin-arm64/ffprobe" \
  "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffprobe"
chmod 755 "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffmpeg" \
  "$RUNTIME/vendor/ffmpeg/darwin-arm64/ffprobe"
for LOCK in node torrserver ffmpeg; do
  cp "$ROOT/packaging/$LOCK-lock.json" "$RUNTIME/packaging/"
done
cp "$ROOT/vendor/node/darwin-arm64/LICENSE" "$RUNTIME/third-party/node-LICENSE.txt"
cp "$ROOT/vendor/node/darwin-arm64/asset-receipt.json" "$RUNTIME/third-party/node-receipt.json"
cp "$ROOT/vendor/ffmpeg/darwin-arm64/asset-receipt.json" "$RUNTIME/third-party/ffmpeg-receipt.json"
cp "$ROOT/packaging/macos-third-party.txt" "$RUNTIME/third-party/NOTICE.txt"

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
# App signing changes the main Mach-O signature; inventory the final bytes
# outside the signed bundle to avoid a signature/inventory dependency cycle.
node "$ROOT/packaging/macos-contract.mjs" stamp "$APP"
echo "$APP"
