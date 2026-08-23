# Distributing the macOS App

How to hand HoshiStream to someone else's Mac. For building on your own machine see
[setup-native-macos.md](setup-native-macos.md).

## Build the disk image

```bash
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
./packaging/build-macos-app.sh
./packaging/build-macos-dmg.sh
```

The second script prints the path to `build/HoshiStream-<version>.dmg`, containing the app,
a symlink to `/Applications`, and `READ ME FIRST.txt` with the install steps below.

## Why a `.dmg` and not a `.zip`

A disk image preserves symlinks, permissions, and the executable bit on the vendored
`node`, `TorrServer`, `ffmpeg`, and `ffprobe` binaries. Zip archives round-tripped through
Finder, email, or chat apps routinely lose them, which surfaces as a "damaged" app. The DMG
is also the artifact a notarization ticket is stapled to once a Developer ID exists.

## What the recipient does

1. Drag `HoshiStream.app` onto `Applications`.
2. Clear the quarantine flag once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/HoshiStream.app
   ```

3. Launch it from Applications. It appears in the menu bar, not the Dock.

Step 2 is required because this build carries an ad-hoc signature rather than an Apple
Developer ID. Gatekeeper quarantines the app and its nested binaries, and typically reports
"HoshiStream is damaged and can't be opened" — a dialog with no "Open Anyway" button, so
the Privacy & Security override does not help. The `-r` flag matters: it clears the flag
from the bundled executables, not just the outer bundle.

Installing to `/Applications` also avoids Gatekeeper path randomization, which runs a
quarantined app from a read-only temporary location where it cannot see its own resources.

## First run

The app is portable across Macs: it resolves its state directory at runtime rather than at
build time. On first launch it creates

```
~/Library/Application Support/HoshiStream
```

with a `.env` (mode `0600`) holding a freshly generated `ACCESS_TOKEN`, a `MEDIA_DIR`
defaulting to `~/Movies`, an empty `library.json`, and TorrServer's data directories. No
manual configuration is needed before the first launch.

To use a different media folder, edit `MEDIA_DIR` in that `.env` and choose **Restart
Server** from the menu bar.

A development build can point at a checkout instead:

```bash
HOSHISTREAM_PROJECT_ROOT=/path/to/checkout ./packaging/build-macos-app.sh
```

## Known limitations

- **Apple Silicon only.** The vendored `node`, `TorrServer`, and `ffmpeg` binaries are
  `darwin-arm64`, and the supervisor compiles for the build machine's architecture. Intel
  Macs are not supported by this artifact.
- **No Developer ID signing or notarization.** The `xattr` step above is the workaround.
  Removing it requires an Apple Developer Program membership, a hardened-runtime build, and
  `notarytool` submission — after which the DMG opens with no terminal commands.
- **Firewall prompt.** macOS asks to allow incoming connections on first launch. Accept it,
  or other devices on the LAN cannot reach the add-on.
- **Each install generates its own access token,** so tokenized add-on URLs are per-machine
  and are not portable between installs.
