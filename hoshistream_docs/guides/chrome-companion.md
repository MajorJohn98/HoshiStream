# Chrome companion

The companion adds manually selected media to HoshiStream on the same computer.
It does not search torrent indexes or require a server address/access token.

## Normal use

1. Open the HoshiStream desktop app once so it registers its native helper.
2. Install and pin the Chrome companion.
3. Right-click a magnet link and choose **Add to HoshiStream**, or open the
   companion's side panel from the toolbar.
4. Review the name, type and optional tags/destination, then add.
5. Follow the separate source check, or open the saved entry in HoshiStream.

The page-link chooser reads only the active page after an explicit action.
If several sources are present, choose one rather than relying on an automatic
guess. For a protected `.torrent` link, download it normally in the browser and
choose/drop the file in the companion. Browser cookies are never exported.

Adding to an existing series requires an inspected target and explicit approval
of overlapping episodes. A saved/check-failed result is still saved; retry the
check rather than creating the entry again.

## Current local-development installation

The commands in this section are for macOS. Windows needs the built Windows
native-host executable; running just the Node server does not install a native
Chrome bridge. See [Windows setup](setup-native-windows.md) for the desktop
candidate and private extension installation.

The extension has not been published to the Chrome Web Store. For this version,
local testing uses Chrome's **Load unpacked** flow:

```bash
cd addon
npm run build
cd ..
node scripts/register-browser-bridge.mjs \
  --runtime-root="$PWD" \
  --project-root="$PWD" \
  --state-dir="$PWD/native-data"
node packaging/build-chrome-extension.mjs
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and
select `addon/assets/chrome-extension`. Pin the companion. Run the development
server separately with `npm run dev:native` from `addon/`.

The zip is `build/HoshiStream-Chrome-Companion.zip`. It contains extension files
only, not server credentials or the native helper.

Development extension ID: `haijooeeommbnonlnkmcihmcgjmbfjgo`.
Native host name: `com.hoshistream.chrome`.

Registration creates a private configuration/launcher under
`<state dir>/browser-bridge/` and a user-level manifest under
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`.
It contains paths and the extension ID, not the access token. Explicit development
registration points at the checkout's library, not the installed app's library.
Opening the packaged app registers its own connection again.

## Distribution

The macOS build includes the native host, registration script and companion
assets. The supervisor requests registration on normal startup. Install the app
in its final location and open it before using the companion.

Windows desktop builds include a separate native-messaging executable under
`native-host/`. The per-user
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hoshistream.chrome`
registration points to an absolute manifest path. Configuration remains under
the private state directory, contains no access token, and permits only the
matching extension ID. Upgrades/uninstall must change only registrations owned
by that installation.

For the agreed unsigned Windows private-sharing release, load the matching
extension ZIP unpacked. This is a private testing/distribution workflow, not a
claim that the extension is published or that the desktop installer installs
it in Chrome automatically.

For a production release, reserve/publish a Chrome Web Store listing, obtain its
public key/ID, update the extension manifest identity, and rebuild the app so the
native host allowlist matches. Do not tell normal users to use Developer mode as
the finished distribution flow. Store publication/review is separate from
building the extension zip.

## Remove the macOS companion during uninstall

Remove the extension from `chrome://extensions` and close its panel. Quit
HoshiStream first so the supervisor cannot re-register the bridge. Before
moving the app to Trash, unregister only the native host owned by this
installation (default installed paths shown):

```bash
RUNTIME="/Applications/HoshiStream.app/Contents/Resources/runtime"
STATE="$HOME/Library/Application Support/HoshiStream"
"$RUNTIME/bin/node" "$RUNTIME/scripts/register-browser-bridge.mjs" \
  --unregister --runtime-root="$RUNTIME" \
  --project-root="$STATE" --state-dir="$STATE"
```

The command reports `removed: true` when it removes the matching Chrome
manifest. `removed: false` means no matching owned registration was removed;
do not manually delete another installation's manifest. It preserves private
bridge configuration, library and media. Reopening the installed app
re-registers its helper, so leave it stopped when uninstalling.
For a checkout/custom installation, supply its actual project/state/runtime
roots instead. See [app-only uninstall](backup-restore-updates.md#uninstall-without-deleting-the-library).

## Troubleshooting

- **Helper not found:** open/update HoshiStream, then retry. For development, run
  the explicit registration command after building.
- **Helper disconnects from a checkout in Documents:** macOS may deny Chrome's
  native helper access to the checkout without exposing a Chrome entry in
  **Files and Folders**. That list does not let you manually add Chrome.
  Prefer the supported installed-app setup: stop the development server, install
  the current app in Applications, and open it to register its bundled helper.
  The installed app keeps its state in Application Support and uses its own
  existing library, not the checkout's library. Retry the connection in the
  companion. Do not disable macOS protections or grant broad disk access just
  to run the development helper.
- **App not running:** use **Open HoshiStream** when the installed app is available.
  A checkout registration requires its development server to be started manually.
- **Connection interrupted:** retry the original confirmation; its idempotency key
  prevents a duplicate save.
- **Draft expired:** preserve the selected source and prepare it again explicitly.
- **Check failed:** the entry is retained. Open it to retry, select files, or use
  the existing compatible/native playback options.

The Windows desktop release extends native helper support under ADR 0022.
Connecting the companion to a different LAN computer remains unsupported.
Use only media you are authorized to access.
