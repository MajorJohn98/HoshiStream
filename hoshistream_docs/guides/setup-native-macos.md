# Setup: Native macOS App

The menu-bar app bundles Node and TorrServer, preserves the library and tokenized URLs, and supervises both services without Docker. See [ADR 0003](../decisions/0003-native-menu-bar-app-no-electron.md) for the rationale.

## Build and install

```bash
node packaging/fetch-node-runtime.mjs
node packaging/fetch-torrserver.mjs
./packaging/build-macos-app.sh
mkdir -p ~/Applications
ditto build/HoshiStream.app ~/Applications/HoshiStream.app
open ~/Applications/HoshiStream.app
```

Runtime downloads are pinned by `packaging/node-lock.json` and `packaging/torrserver-lock.json`.

## Menu-bar controls

- Open HoshiStream (management page in the default browser)
- Copy the Stremio URL
- Restart the server
- Reveal logs
- Start at Login
- Quit (stops both services cleanly)

## State and logs

| Path | Contents |
|---|---|
| `~/Library/Application Support/HoshiStream` | Library, settings, managed media |
| `~/Library/Logs/HoshiStream/server.log` | Server logs |

## Native file pickers

When the menu-bar app runs, the Finder file/folder controls on the management page link media in its original location without copying. A folder is added as one series; filenames such as `S01E02` or `1x02` supply episode numbers, otherwise files become season 1 in filename order. After moving or renaming media, use **Edit → Relink in Finder**.

Deleting a Finder-linked entry never deletes its source file. The browser upload fallback (available without the native app) copies videos into managed HoshiStream storage instead.

## Playback notes

Keep the Mac awake during playback (`caffeinate -dimsu`); closing the lid may suspend networking and stop playback.
