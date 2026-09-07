# HoshiStream

A private, local-first media library and Stremio-compatible add-on for Nuvio.
Add your own authorized videos, magnets or `.torrent` files, then watch in your
browser or a player on the same **trusted home LAN**. No torrent discovery,
accounts or containers.

The **0.14.0 closed-beta candidate** targets Apple Silicon, macOS 13.5+, and
one direct-play stream. Browser baseline: **MP4 with H.264 video and AAC audio**.
Exact browser/Nuvio/Stremio versions and recipient playback are still awaiting
acceptance. Existing opt-in stream repair and remote access are outside this beta.

## 1. Install the macOS app - recommended

You need an Apple Silicon Mac running macOS 13.5 or later and a modern browser.
**You do not need Node, npm, build tools or mpv.** The app bundles Node,
TorrServer, FFmpeg and ffprobe; playback in the management page uses your browser.

1. Open [release downloads](https://github.com/MajorJohn98/HoshiStream/releases).
   **The latest published artifact is still 0.8.2, not this candidate.**
   Wait for an approved 0.14.0 image, checksum and release notes; do not treat the
   older download or a `LOCAL-ONLY` image as the closed beta.
2. Download the approved DMG and matching `.sha256`, verify it using the
   [installation guide](hoshistream_docs/guides/distributing-macos-app.md#install-an-approved-image),
   open the image and copy HoshiStream to Applications. The candidate is
   **ad-hoc signed, not notarized**: macOS may block it. Only for a build you
   trust, use **System Settings > Privacy & Security > Open Anyway**, or follow
   the guide's app-scoped assisted procedure. Never disable Gatekeeper globally.
3. Open HoshiStream in Applications. Look in the **menu bar**, not the Dock.
   Allow incoming connections for trusted-LAN playback when macOS prompts.
4. In **Get started**, choose **Add media**, review an authorized title and save.
   Open the title and choose **Play** for browser playback. To use Nuvio or
   Stremio, copy the **private add-on URL** into that player's add-on settings.
   Keep the Mac running and awake while watching.

First launch generates private configuration and state in
`~/Library/Application Support/HoshiStream`; no developer credentials are needed.
Private URLs grant access to your library: do not share them publicly.
mpv is **optional and separately installed**, not required by the browser path;
the [playback notes](hoshistream_docs/guides/setup-native-macos.md#playback-notes)
explain the advanced external-player API.

Optional: [pointer setup](hoshistream_docs/guides/pointer-server-vercel.md)
(manual, stable LAN address, not remote streaming),
[Chrome companion](hoshistream_docs/guides/chrome-companion.md)
(separately gated technical installation).
[Getting started](hoshistream_docs/guides/getting-started.md) |
[Troubleshooting](hoshistream_docs/guides/troubleshooting.md)

## 2. Run from the codebase in a terminal - optional

On an Apple Silicon Mac, install **Git, Node 22.18+ and npm**. Stop any other
HoshiStream instance first; the app and terminal stack use the same default
service and peer ports.

```bash
git clone https://github.com/MajorJohn98/HoshiStream.git
cd HoshiStream
cd addon
npm ci
cd ..
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
node scripts/native-server.mjs --dev
```

This runs **both TorrServer and the add-on in the foreground**, directly from
TypeScript. It does not build or install a menu-bar app. Keep the terminal open;
**Ctrl+C** stops the stack.

First run generates `.env` in the checkout. Open that file privately in a local
editor and use its `ACCESS_TOKEN` in
`http://127.0.0.1:7001/manage/<ACCESS_TOKEN>` (use your `ADDON_PORT` if changed).
Do not paste the token or private URL into logs, issues or screenshots. Add media
and watch as above; browser uploads work, but **native Finder pickers and
companion registration are not provided by this command**.

This mode uses checkout `.env`, `native-data/` and `data/media/`, not the installed
app's library. See [development and exact state paths](hoshistream_docs/guides/development.md)
for watch mode, add-on-only `npm run dev`, and the advanced installed-state
`start-native.sh` / `stop-native.sh` alternatives.

## 3. Build the macOS app from source - optional

Use an Apple Silicon Mac, **Git, Node 22.18+, npm and Apple's Command Line Tools**
(`xcode-select --install`; a full Xcode also works). From a fresh checkout:

```bash
git clone https://github.com/MajorJohn98/HoshiStream.git
cd HoshiStream
cd addon
npm ci
cd ..
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
node packaging/fetch-ffmpeg.mjs
./packaging/build-macos-app.sh
./packaging/build-macos-dmg.sh --stage-only
```

The fetched runtimes are checksum-pinned; the app's Node version comes from
`packaging/node-lock.json`, independently of the source-mode minimum. No macOS
mpv fetch is needed. The app is `build/HoshiStream.app`; the local-validation
DMG is `build/HoshiStream-<buildId>-darwin-arm64-LOCAL-ONLY.dmg`, with checksum,
build metadata and notes alongside it.

For personal use, quit an existing instance, copy `build/HoshiStream.app` into
Applications with Finder, and open it. **Leave `HOSHISTREAM_PROJECT_ROOT` unset**
for portable builds: state and credentials are created on the recipient's Mac,
never copied from your checkout. Use a separate `HOSHISTREAM_BUILD_DIR` to
preserve an existing build.

**Building is not redistribution approval.** The normal DMG command (without
`--stage-only`) requires reviewed exact third-party source/license/build
materials. Publication also waits for the remaining beta acceptance gates.
See the [full build guide](hoshistream_docs/guides/setup-native-macos.md) and
[distribution requirements](hoshistream_docs/guides/distributing-macos-app.md).

Windows 11 x64 remains a separately gated
[desktop candidate](hoshistream_docs/guides/setup-native-windows.md), not part of
this initial cohort. Architecture, API examples, tuning and engineering checks
live in the [documentation index](hoshistream_docs/index.md).
