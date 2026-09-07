# Get started with HoshiStream

The desktop app opens **Get started** on a fresh installation once its local server
is ready. You can skip setup and return from the app's menu-bar or Windows tray menu, or the
management page's sidebar. Existing installations are not interrupted by a new
welcome window.

## Add a title

Choose **Add media** and use a magnet link, a `.torrent` file, or a video already
on your computer. Only add media you own or are authorized to access. Review the
details before saving.

The first step completes when a title is actually in your library. Source checks
remain separate: saving a title is not a promise that it will play. Open the
entry to inspect its files, check the source, or investigate a playback problem.

## Connect Nuvio or Stremio

Keep the player device on the same home network as the host computer. In Get started,
choose your player and copy the **private add-on URL**. The URL uses the host's
configured network address, not the management browser's localhost address.

- **Nuvio:** open Addons, choose Add Addon, and paste the URL.
- **Stremio:** open Add-ons, paste the URL into the add-on search field, and
  install HoshiStream.

Menu wording may vary between client versions. Once HoshiStream appears in the
player's add-ons, return and choose **I can see HoshiStream**. Copying the URL does
not count as a confirmed connection. If a recognized player has recently requested
the catalog, the page reports that activity separately.

The URL grants access to your library: do not publish or share it. If copying is
unavailable, expand **Show private URL** and copy it manually. If the page reports
that the address works only on this computer, connect it to the home network and
restart HoshiStream before adding it on another device.

## Finish or come back later

**Finish setup** becomes available after a title is added and you confirm the
player setup. Keep HoshiStream running and the computer awake while watching. A changed
LAN address may require copying the updated URL into your player.

Progress and dismissal are stored in `onboarding.json` alongside the installed
app's state. There are no accounts or onboarding analytics. **Skip for now**
does not change your media or settings; the guide remains accessible. Choosing a
different player clears its previous confirmation.

Magnet-link defaults, Start at Login, and the Chrome companion are optional and
are never enabled automatically by onboarding. An incoming magnet on first launch
takes priority over opening the welcome page.
