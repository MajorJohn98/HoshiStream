#!/bin/sh
# Package build/HoshiStream.app as a distributable disk image.
#
# A .dmg is preferred over a zip: it preserves symlinks, permissions, and the
# executable bit on the vendored node/TorrServer/ffmpeg binaries, and it is the
# artifact a notarization ticket gets stapled to once a Developer ID is in play.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR="${HOSHISTREAM_BUILD_DIR:-$ROOT/build}"
APP="$BUILD_DIR/HoshiStream.app"

if [ ! -d "$APP" ]; then
  echo "Build the app first: packaging/build-macos-app.sh" >&2
  exit 1
fi

BUILD_ID=$(node "$ROOT/packaging/release-identity.mjs" verify-app "$APP")
ARTIFACT="HoshiStream-$BUILD_ID-darwin-arm64"
DMG="$BUILD_DIR/$ARTIFACT.dmg"
STAGE="$BUILD_DIR/dmg-stage"

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/HoshiStream.app"
# The drag-to-install target, so testers do not run the app from ~/Downloads
# where Gatekeeper path randomization hides its own resources from it.
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/packaging/dmg-readme.txt" "$STAGE/READ ME FIRST.txt"
cp "$APP/Contents/Resources/runtime/addon/release.json" "$STAGE/release-info.json"

hdiutil create -volname "HoshiStream" -srcfolder "$STAGE" \
  -ov -format UDZO "$DMG" >/dev/null
cp "$STAGE/release-info.json" "$BUILD_DIR/$ARTIFACT.release.json"
rm -rf "$STAGE"
echo "$DMG"
