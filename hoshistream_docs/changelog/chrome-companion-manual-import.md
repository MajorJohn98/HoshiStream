# Chrome companion and manual import

The in-app discovery feature is retired in favor of manual media adding and a
same-computer Chrome companion for macOS.

- Removed discovery providers, provider configuration and the Search surface.
- Preserved existing libraries, source files, legacy provenance, source checks
  and retry receipts.
- Added provider-neutral import drafts, content-hash deduplication, durable
  confirmation and explicit series-overlap review.
- Added a Manifest V3 side panel with user-triggered link capture and file input.
- Added a bounded native-messaging relay that keeps the local access token out
  of the extension and exposes no arbitrary file/HTTP/shell commands.
- Added macOS helper registration and a companion zip build.
- Refined the companion in 0.1.1 to match the app's flat, hairline-separated
  sections, compact connection indicators, ember controls and segmented type
  selector. Capture tips are disclosed on demand; file selection is keyboard
  accessible, and pending confirmations lock the type/destination controls.

The normal macOS app requests native registration on startup. Development
registration remains explicit so a checkout does not silently replace an
installed app's connection.

The macOS app also supports opt-in system-wide magnet handling. A clicked link
opens the existing Add Media form with its source prefilled, including on cold
start. Expiring, authenticated handoff tickets keep the magnet out of browser
URLs; saving remains a separate confirmation.

The Chrome Web Store listing is not published by this implementation; local
testing uses Load unpacked. See [the companion guide](../guides/chrome-companion.md)
and [ADR 0020](../decisions/0020-manual-import-chrome-companion.md).
