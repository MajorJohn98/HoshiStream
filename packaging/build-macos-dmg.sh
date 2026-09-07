#!/bin/sh
# Package build/HoshiStream.app as a distributable disk image.
#
# A .dmg is preferred over a zip: it preserves symlinks, permissions, and the
# executable bit on the vendored node/TorrServer/ffmpeg binaries, and it is the
# artifact a notarization ticket gets stapled to once a Developer ID is in play.
set -eu
MODE=release
case "${1:-}" in
  "") ;;
  --stage-only) MODE=local ;;
  *) echo "Usage: build-macos-dmg.sh [--stage-only]" >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { echo "Unexpected arguments" >&2; exit 1; }

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUILD_DIR="${HOSHISTREAM_BUILD_DIR:-$ROOT/build}"
APP="$BUILD_DIR/HoshiStream.app"

if [ ! -d "$APP" ]; then
  echo "Build the app first: packaging/build-macos-app.sh" >&2
  exit 1
fi

BUILD_ID=$(node "$ROOT/packaging/macos-contract.mjs" verify "$APP")
ARTIFACT="HoshiStream-$BUILD_ID-darwin-arm64"
REDISTRIBUTION="$ROOT/vendor/macos-redistribution"
if [ "$MODE" = release ]; then
  node "$ROOT/packaging/macos-contract.mjs" redistribution \
    "$REDISTRIBUTION" "$APP/Contents/Resources/runtime"
else
  ARTIFACT="$ARTIFACT-LOCAL-ONLY"
fi
DMG="$BUILD_DIR/$ARTIFACT.dmg"
STAGE="$BUILD_DIR/dmg-stage"

# Never overwrite an earlier candidate or its checksum.
if [ -e "$DMG" ]; then
  echo "Artifact already exists; rebuild for a new identity: $DMG" >&2
  exit 1
fi
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/HoshiStream.app"
cp "$APP.payload.json" "$STAGE/HoshiStream.app.payload.json"
# The drag-to-install target, so testers do not run the app from ~/Downloads
# where Gatekeeper path randomization hides its own resources from it.
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/packaging/dmg-readme.txt" "$STAGE/READ ME FIRST.txt"
cp "$APP/Contents/Resources/runtime/addon/release.json" "$STAGE/release-info.json"
cp "$ROOT/packaging/macos-release-notes.txt" "$STAGE/RELEASE NOTES.txt"
if [ "$MODE" = release ]; then
  cp -R "$REDISTRIBUTION" "$STAGE/third-party-redistribution"
else
  cp "$ROOT/packaging/macos-local-only.txt" "$STAGE/LOCAL VALIDATION ONLY.txt"
fi

hdiutil create -volname "HoshiStream" -srcfolder "$STAGE" \
  -format UDZO "$DMG" >/dev/null
cp "$STAGE/release-info.json" "$BUILD_DIR/$ARTIFACT.release.json"
cp "$APP.payload.json" "$BUILD_DIR/$ARTIFACT.payload.json"
cp "$STAGE/RELEASE NOTES.txt" "$BUILD_DIR/$ARTIFACT.notes.txt"
node "$ROOT/packaging/macos-contract.mjs" checksum "$DMG"
rm -rf "$STAGE"
echo "$DMG"
