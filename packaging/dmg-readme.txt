HoshiStream — install notes
===========================

1. Drag HoshiStream.app onto the Applications folder in this window.

2. This build is signed with an ad-hoc signature rather than an Apple
   Developer ID, so macOS quarantines it and may report it as "damaged".
   Clear the quarantine flag once, in Terminal:

       xattr -dr com.apple.quarantine /Applications/HoshiStream.app

   The -r matters: it also clears the flag from the bundled node,
   TorrServer, and ffmpeg binaries.

3. Launch HoshiStream from Applications. It appears in the menu bar, not
   the Dock. The first launch creates:

       ~/Library/Application Support/HoshiStream

   containing a .env with a freshly generated access token, plus the
   library and TorrServer data.

4. Open the menu-bar icon and choose "Open HoshiStream" for the library,
   or "Copy Stremio URL" to add the add-on to Nuvio or Stremio.

To point the app at a different media folder, edit MEDIA_DIR in
~/Library/Application Support/HoshiStream/.env and choose "Restart Server".
