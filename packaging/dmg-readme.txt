HoshiStream — install notes
===========================

This build is signed with an ad-hoc signature rather than an Apple Developer
ID, so macOS quarantines it. Dragging it to Applications and double-clicking
will be blocked with "Apple could not verify HoshiStream is free of malware"
(or, on older macOS, a claim that the app is damaged).

Install it with Terminal instead. Copy and paste this whole block:

    ditto /Volumes/HoshiStream/HoshiStream.app ~/Downloads/HoshiStream.app
    xattr -dr com.apple.quarantine ~/Downloads/HoshiStream.app
    mv ~/Downloads/HoshiStream.app /Applications/
    open /Applications/HoshiStream.app

The order matters: macOS blocks the xattr command once the app is already in
/Applications, so the flag has to be cleared while the copy is still in
Downloads.

No Terminal? Drag HoshiStream.app onto the Applications folder in this
window, double-click it, dismiss the warning, then go to
System Settings -> Privacy & Security and click "Open Anyway".

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

To point the app at a different media folder, edit MEDIA_DIR in
~/Library/Application Support/HoshiStream/.env and choose "Restart Server".
