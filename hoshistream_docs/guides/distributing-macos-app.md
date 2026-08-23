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

Because this build carries an ad-hoc signature rather than an Apple Developer ID, macOS
quarantines it. Dragging it into Applications and double-clicking is blocked: macOS 15 and
later report "Apple could not verify HoshiStream is free of malware", earlier versions
report that the app is damaged.

Clear the quarantine flag **before** the app reaches `/Applications`:

```bash
hdiutil attach ~/Downloads/HoshiStream-<version>.dmg
ditto /Volumes/HoshiStream/HoshiStream.app ~/Downloads/HoshiStream.app
xattr -dr com.apple.quarantine ~/Downloads/HoshiStream.app
mv ~/Downloads/HoshiStream.app /Applications/
hdiutil detach /Volumes/HoshiStream
open /Applications/HoshiStream.app
```

The order is not incidental. Running `xattr` against an app already inside `/Applications`
fails with "Operation not permitted" on every file it touches, because macOS Sonoma and
later require the App Management permission to modify an installed bundle. The command
appears to run, changes nothing, and the app still refuses to launch. Granting Terminal
App Management under **System Settings → Privacy & Security** also works, but asking a
tester to hand a terminal that privilege is a worse trade than staging the copy.

The `-r` flag matters as well: it clears the flag from the bundled `node`, `TorrServer`,
and `ffmpeg` binaries rather than only the outer bundle. On a fresh copy this clears
around ten thousand files.

Without a Terminal, drag the app to Applications, double-click it, dismiss the warning,
then approve it under **System Settings → Privacy & Security → Open Anyway**.

Installing to `/Applications` also avoids Gatekeeper path randomization, which runs a
quarantined app from a read-only temporary location where it cannot see its own resources.

Note that `spctl --assess` continues to report `rejected` after the flag is cleared. That
is expected: the assessment reflects the missing Developer ID signature, not a launch
block. Without the quarantine flag, Gatekeeper does not consult it.

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
