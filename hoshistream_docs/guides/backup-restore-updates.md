# Backup, restore and manual updates

The first beta uses **manual, stopped-state backups and same-path restores**.
There is no automatic updater or universal downgrade guarantee. A browser JSON
export and `library.json.bak` are not full backups. Keep backups private: they
contain credentials, library information, source references and possibly media.
Use FileVault and an encrypted, access-controlled backup destination; these
commands copy files, not encrypt them.

## Resolve the installation before copying anything

Record the installed **About HoshiStream** build ID and retain its original DMG,
checksum and release notes alongside the backup. A package version alone is not
an identity. Do not start a second copy while investigating paths.

| Mode                       | Project/configuration root                                          | State root                                          | Managed files                                                                    |
| -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Portable installed Mac app | `~/Library/Application Support/HoshiStream`                         | Same directory                                      | `<project>/data/media/`, including uploaded videos and imported `.torrent` files |
| Foreground checkout        | Checkout (`.env` at its root)                                       | `<checkout>/native-data/`                           | `<checkout>/data/media/`                                                         |
| `start-native.sh`          | Installed state directory by default                                | Same directory by default                           | `<project>/data/media/`                                                          |
| Custom/development build   | Resolve `HoshiStreamProjectRoot` in the app's `Contents/Info.plist` | The Mac shell passes the project root as state root | `<project>/data/media/`                                                          |
| Custom terminal launcher   | Resolve `--project-root` and `--state-dir` / start-script overrides | The explicitly selected directory                   | `<project>/data/media/`                                                          |

The Mac shell does not use a `.env` `HOSHISTREAM_STATE_DIR` override; terminal
start scripts have their own overrides. Add-on-only mode can place each store
independently through configuration and needs an individually reviewed inventory.
Do not apply the installed-app commands to a checkout or guess a root from an
old guide.

Copy the **entire resolved state directory**, not a selected JSON export. It
includes `library.json` and its `.bak`/quarantines, `.env` when colocated,
`onboarding.json`, `tags.json` (with its `pinned` list), `identity.json`,
`device-names.json`, `pointer-settings.json`,
`pointer-state.json`, `volumes.json`, `disk-cleanup.json`, `disk-schedule.json`,
TorrServer `config/` (including `config.db` and settings), `thumbnails/`
(episode frames — regenerable from the Episodes tab, so optional), and cache
directories.
For checkout/custom layouts also copy the project `.env` and entire `data/`
directory separately; record all original absolute paths. Never back up a
whole checkout merely to capture these three locations.

Linked files/folders (including a Finder-linked `.torrent`) stay in their
original locations; back them up separately. For any existing disk library,
preserve each registered storage root, its `.hoshistream-volume.json` marker
and copied media together with the JSON registry/cleanup/schedule state. Do not
mount a restored clone alongside a drive with the same marker: duplicate
identities are ambiguous. External-drive recovery is outside first-cohort
acceptance and needs owner assistance.

Conservatively retain cache/transcode directories in this initial procedure;
allow enough free space for the full snapshot and a second restore staging copy.
Logs are not needed to restore, but preserve them privately for an incident:
the app uses `~/Library/Logs/HoshiStream`, terminal launchers use `<state>/logs`.
Browser history, player-side state, system login/default-handler settings and
Chrome's external native-host registration are separate from the state backup.

## Stop, then back up

Turn off **Start at Login**, close player sessions and the Chrome companion, and
choose **Quit HoshiStream**, not Restart Server. Stop terminal/watch instances
with their normal Ctrl+C or `stop-native.sh` control. Wait for the menu-bar app,
owned Node and TorrServer to exit. Confirm the configured service ports are no
longer listening in Activity Monitor or with `lsof -nP -iTCP:7001 -sTCP:LISTEN`
and the equivalent for `8090` (use your configured ports).

A remaining runtime lock or supervisor socket blocks this procedure, even if
it looks stale. Ask the owner to resolve it; do not delete locks, kill an
unidentified PID, or back up a still-recovering instance. These guards complement,
not replace, confirming all writers have stopped.

For the **default installed Mac app**, open a private Terminal and set absolute
paths. Choose a new backup name outside the state directory. Do not reuse an
existing backup or use a sync service that exposes its contents:

```bash
STATE="$HOME/Library/Application Support/HoshiStream"
BACKUP="$HOME/HoshiStream Backups/2026-09-07-before-update"
mkdir -p "$HOME/HoshiStream Backups"
```

Then run this block; stop on any failure. The `COMPLETE` marker is created only
after the copied tree compares equal. An interrupted copy without the marker is
not a usable backup. Record the build ID separately without printing `.env`.

```bash
# hoshistream-backup
umask 077
test -d "$STATE" && test -f "$STATE/.env" &&
test ! -e "$STATE/run/runtime.lock" &&
test ! -S "$STATE/run/supervisor.sock" &&
mkdir "$BACKUP" &&
/usr/bin/ditto "$STATE" "$BACKUP/state" &&
/usr/bin/diff -qr "$STATE" "$BACKUP/state" &&
touch "$BACKUP/COMPLETE"
```

`ditto` retains hidden files and macOS file metadata; the private parent limits
access. For split checkout/custom roots, use the same stopped-copy-and-compare
process for **all three** inventory locations before marking the snapshot
complete. The single-root block above alone is insufficient for that layout.
Store backups and original-media backups separately from the only live disk.

## Update without changing identity

1. Obtain an owner-approved candidate, read its compatibility notes and verify
   its checksum. `LOCAL-ONLY` images are not beta downloads.
2. Complete the stopped backup above and retain the previous app/DMG. Do not
   update while the supervisor is running or overwrite state with installer
   contents. Replace only `/Applications/HoshiStream.app` using Finder.
3. Launch once at the same installed location. Confirm the new build ID, library
   entries, tags, setup progress, managed media, linked originals and player
   resume position. Existing client URLs and pointer credentials must remain
   unchanged. Saving setup or restarting must not register a pointer.
4. If the LAN address changed, use the deliberate pointer update or copy the
   direct LAN URL. Re-approve the app's firewall access if requested. Restore
   Start at Login only after a successful session.

If anything is missing, stop immediately and preserve both states. Do not
create an empty library, repeatedly retry imports, reconnect external archive
drives, or accept newly generated credentials as a successful upgrade.

## Restore at the original path

Use the artifact that created the backup, or an explicitly accepted forward
reader. Same-path restore is required because entries can contain absolute
paths. A different Mac, account, mount point or root requires an assisted
relink/migration, not search-and-replace of library JSON.

Stop all writers as above. Retain the current directory under a fresh sibling
name, and restore into another new sibling before swapping. Set `STATE` and
`BACKUP` to the original paths, then choose unused `STAGING` and `HOLD` paths:

```bash
STAGING="${STATE}.restore-staging"
HOLD="${STATE}.before-restore"
```

The block preserves current data rather than merging or deleting it. Run it
only after selecting the matching app; do not launch between these operations.

```bash
# hoshistream-restore
umask 077
test -f "$BACKUP/COMPLETE" && test -f "$BACKUP/state/.env" &&
test ! -e "$STAGING" && test ! -e "$HOLD" &&
test ! -e "$STAGING.run-records" && test ! -e "$STAGING.pid-record" &&
test ! -e "$STATE/run/runtime.lock" &&
test ! -S "$STATE/run/supervisor.sock" &&
/usr/bin/ditto "$BACKUP/state" "$STAGING" &&
/usr/bin/diff -qr "$BACKUP/state" "$STAGING" &&
{ test ! -d "$STAGING/run" || mv "$STAGING/run" "$STAGING.run-records"; } &&
{ test ! -f "$STAGING/hoshistream.pid" || mv "$STAGING/hoshistream.pid" "$STAGING.pid-record"; } &&
{ test ! -d "$STATE" || mv "$STATE" "$HOLD"; } &&
mv "$STAGING" "$STATE"
```

Runtime locks/control credentials, sockets and PID records are **not restored
as active runtime metadata**; the snapshot retains them for private inspection.
The app rebuilds native bridge registration on launch. Pending browser capture
tickets and in-flight checks are not a durable backup guarantee.

On any command failure, leave all directories in place and do not launch.
If the final swap fails, the old state remains in `HOLD`; the owner can restore
its name while stopped. After a successful swap, launch the matching artifact
and perform the update checks above. Do not run the restored installation and
another clone with the same pointer credentials simultaneously. Never delete
the backup or `HOLD` merely because startup succeeded.

## Compatibility and rollback policy

| Direction                                                         | Contract                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore snapshot with its exact artifact at its original paths    | Supported procedure; disposable same-path coverage is recorded in the acceptance guide.                                                                             |
| Phase 3-4 local candidate to the phase 5-7 candidate              | No production state-format change is introduced by this slice; packaged reader evidence is narrow and is not recipient upgrade approval.                            |
| Any older published DMG (including `0.8.2`) reading current state | **Not approved.** There is no accepted older-version compatibility matrix.                                                                                          |
| Roll back code after new state has been written                   | Quit; preserve the newer state; restore the older artifact **and its matching pre-update full snapshot**. Post-snapshot changes are not carried back automatically. |

Do not launch an old version on a newer `library.json`: validation may discard
unknown fields when that version writes. Matching `0.15.0` strings do not prove
compatibility. If no matching snapshot/artifact exists, hold rollback and ask
the release owner; do not improvise a downgrade.

## Uninstall without deleting the library

While the app still works, manually remove a registered remote pointer if you
want it removed from the service; merely disabling it or deleting the app does
not remove that record. Keep credentials until removal succeeds. Turn off
Start at Login and, if used, choose a replacement magnet handler. Then quit and
take a final stopped backup. Remove the Chrome extension/native bridge using the
[companion guide](chrome-companion.md#remove-the-macos-companion-during-uninstall)
while the app is stopped but its bundled tools are still available.

Move **only the app bundle** to Trash. Leave the state directory, logs, backups,
managed files, linked originals and external-drive markers untouched. Reinstall
the matching/approved app at the same path to resume with that identity. Do not
use a cleanup utility that deletes Application Support or shared media.
Permanent erasure is a separate, explicit data-deletion decision, not part of
this uninstall procedure.

See [privacy and networking](privacy-and-network.md),
[candidate acceptance](closed-beta-acceptance.md) and
[private beta support](closed-beta-support.md).
