#!/bin/sh
# Package build/HoshiStream.app as a distributable disk image.
#
# A .dmg is preferred over a zip: it preserves symlinks, permissions, and the
# executable bit on the vendored node/TorrServer/ffmpeg binaries, and it is the
# artifact a notarization ticket gets stapled to once a Developer ID is in play.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$ROOT/build/HoshiStream.app"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  "$APP/Contents/Info.plist")
DMG="$ROOT/build/HoshiStream-$VERSION.dmg"
STAGE="$ROOT/build/dmg-stage"

if [ ! -d "$APP" ]; then
  echo "Build the app first: packaging/build-macos-app.sh" >&2
  exit 1
fi

rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/HoshiStream.app"
# The drag-to-install target, so testers do not run the app from ~/Downloads
# where Gatekeeper path randomization hides its own resources from it.
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/packaging/dmg-readme.txt" "$STAGE/READ ME FIRST.txt"

hdiutil create -volname "HoshiStream" -srcfolder "$STAGE" \
  -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "$DMG"
