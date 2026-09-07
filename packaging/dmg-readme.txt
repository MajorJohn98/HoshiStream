HoshiStream — install notes
===========================

Requires an Apple Silicon Mac running macOS 13.5 or later. Intel Macs are not
supported by this build.

Read RELEASE NOTES.txt and any LOCAL VALIDATION ONLY.txt notice first.
A LOCAL-ONLY image is not approved for sharing. Verify the image's SHA-256
against its trusted release checksum before installation.

This build has an ad-hoc signature, not Developer ID signing or notarization.
macOS may block it; wording and overrides vary by OS and device policy.
Only for an approved build you trust, copy it to Applications, try opening it,
then use System Settings -> Privacy & Security -> Open Anyway if offered.
Never disable system-wide protections or bypass an organization's policy.

For an assisted fresh installation, the following app-scoped alternative
requires no existing copy in Downloads or Applications. Quit any running
instance first; do not delete existing state or an older app to force an upgrade.

    test ! -e "$HOME/Downloads/HoshiStream.app" &&
    test ! -e "/Applications/HoshiStream.app" &&
    ditto /Volumes/HoshiStream/HoshiStream.app "$HOME/Downloads/HoshiStream.app" &&
    xattr -dr com.apple.quarantine "$HOME/Downloads/HoshiStream.app" &&
    mv "$HOME/Downloads/HoshiStream.app" /Applications/ &&
    open /Applications/HoshiStream.app

This removes quarantine only from this trusted app. Staging in Downloads avoids
App Management/permission restrictions on already installed apps. If blocked
by policy or if the command fails, stop and ask the release owner for help.

After launching
---------------

HoshiStream appears in the menu bar, not the Dock. macOS will ask to allow
incoming connections — accept, or other devices on your network cannot reach
it.

The first launch creates:

    ~/Library/Application Support/HoshiStream

containing a .env with a freshly generated access token, plus the library and
TorrServer data. Nothing needs configuring first.

Open the menu-bar icon and choose "Open HoshiStream" for the library, or
"Copy Stremio URL" to add the add-on to Nuvio or Stremio.

Use Get started to add an authorized title. Play opens the browser player;
H.264/AAC MP4 is the candidate baseline. Node, TorrServer, FFmpeg and ffprobe
are bundled. No Node, npm or build tools are needed. mpv is NOT bundled;
separately installed external players are optional, advanced alternatives.
Keep the Mac awake and devices on the same trusted LAN.

Private add-on URLs grant access to the library; do not publish them.
Remote Pointer Settings is optional and user-triggered, not remote streaming.

To point the app at a different media folder, edit MEDIA_DIR in
~/Library/Application Support/HoshiStream/.env and choose "Restart Server".
