# New-user onboarding

- Added a skippable Get started page with real Add Media actions and Nuvio/Stremio
  connection instructions.
- Added a private LAN add-on URL with clipboard and manual-copy options.
- Progress uses actual library contents and explicit player confirmation, not
  clicks on Copy or assumptions about playback.
- Added local, owner-readable `onboarding.json` state for dismissal, player choice
  and completion. Invalid state is preserved and does not block the library.
- Fresh macOS installs open setup once after the server is ready. Existing
  installations are not interrupted; magnet handoffs keep priority.
- Added menu/sidebar access and a useful empty-library state.
- Optional browser, magnet-default and login shortcuts stay optional.
