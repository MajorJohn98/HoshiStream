# Chrome companion and manual import

Date: 2026-09-06
Status: implemented for Chrome/macOS; Chrome Web Store publication remains separate.

## Delivery

Discovery has been removed, the manual import API and Chrome companion are
implemented, and the macOS app bundles its native helper. The companion zip and
macOS app build are available under `build/`. The user-approved installed-app
update is running from Applications, with native registration pointing at its
existing Application Support state. The development server is stopped and its
separate library is untouched.

Native framing against the development server and browser UI flows with an
isolated native fixture were exercised. macOS blocked the checkout helper in
Documents, so the user selected the supported installed-app setup. Real Chrome
native messaging to that installed app now succeeds, reporting both the app and
engine ready. Its existing settings and library were preserved.

## Approved scope

Replace in-app torrent discovery with manual adding assisted by a Chrome
Manifest V3 companion. First version: Chrome and the HoshiStream macOS app on
the same computer. Keep the current dark/ember visual identity and make the
primary loop capture -> review -> add -> check understandable without ports,
tokens, indexer setup, or browser automation.

Remove provider adapters, provider configuration, search routes, and search UI.
Preserve every existing library entry and managed source file, including legacy
search provenance used for deduplication and reviewed-file selection. Keep manual
Add, source checks, upload durability, and explicit series-overlap approval.

## Workstreams

1. Extract provider-neutral import drafts/commit/series preview from search, remove
   provider code and HTML-parser dependencies, and keep compatibility schemas.
2. Build a least-privilege Chrome side panel, context-menu magnet capture, on-demand
   active-page link capture, manual magnet paste, and .torrent file selection.
3. Bundle a narrow native-messaging host, register it from the macOS app, and relay
   only approved commands to the local management API without exposing its token.
4. Produce an extension zip/development install path, update setup/architecture
   docs, exercise native framing/import/UI flows with isolated fixtures, and
   restore the development server.

## Backend import contract

All routes retain bearer auth and no-store responses.

| Endpoint | Input / output |
|---|---|
| `GET /api/imports/capabilities` | `{version:1,maxTorrentBytes:1000000}` |
| `GET /api/imports/series` | `{entries:[{id,name,inspected,sourceCount}]}`; eligible torrent-backed series only |
| `POST /api/imports/prepare` | `{magnetUri}` -> draft |
| `POST /api/imports/prepare-torrent` | Raw torrent bytes, at most 1 MB -> draft |
| `DELETE /api/imports/drafts/{draftId}` | Reclaim an unused draft; `204` |
| `POST /api/imports/commit` | `{draftId,name,type,tags?,idempotencyKey}` -> `{entry,outcome:"created"|"existing"}` |
| `POST /api/imports/series-preview` | `{draftId,entryId,seasonHint?}` -> `{previewId,expiresAt,entryId,entryName,addedEpisodes,replacements}` |
| `POST /api/imports/series-commit` | `{previewId,idempotencyKey,allowReplace}` -> `{entry,outcome:"appended"|"existing"}` |
| `DELETE /api/imports/previews/{previewId}` | Reclaim an unused preview; `204` |

A draft is `{draftId,expiresAt,hash,suggestedName?,existingEntries:[{id,name,type}]}`.
It is bounded/expiring and contains no client-visible local file path. Commit
checks durable receipts before requiring a live draft, then atomically deduplicates
by content hash. A new optional server-owned sourceHash can identify manual
torrents; legacy searchImport/searchReceipts remain readable.

Draft/preview file ownership must be explicit: cancellation, expiry, restart
cleanup and concurrent commit must never delete referenced or user-owned files.
Series preview requires an inspected target and never silently replaces episodes.

## Native messaging contract

Host name: `com.hoshistream.chrome`.
Development extension ID: `haijooeeommbnonlnkmcihmcgjmbfjgo`.
Native messages are UTF-8 JSON with Chrome's length prefix and bounded framing.

Request: `{version:1,id:<UUID>,command,payload:{...}}`.
Response: `{version:1,id,ok:true,data}` or
`{version:1,id,ok:false,error:{code,message,retryable?,uncertain?}}`.

| Command | Payload / result |
|---|---|
| `status` | `{}` -> `{connected,appRunning,engineReady,canStartApp,message?}` |
| `startApp` | `{}` -> status; launch only the configured HoshiStream app |
| `tags` | `{}` -> `{tags:[{name,count}]}` |
| `series` | `{}` -> backend series summaries |
| `prepareMagnet` | `{magnetUri}` -> draft |
| `prepareTorrent` | `{bytesBase64,fileName}` -> draft; decoded bytes <= 1 MB |
| `discardDraft` | `{draftId}` -> `{}` |
| `createEntry` | Commit input plus `checkAfterSave:boolean` -> sanitized `{entry,outcome,check?,checkError?}` |
| `previewSeries` | Backend series-preview input -> preview |
| `commitSeries` | Series-commit input plus `checkAfterSave:boolean` -> sanitized result |
| `discardPreview` | `{previewId}` -> `{}` |
| `startCheck` | `{entryId,fileId?}` -> source-check report |
| `getCheck` | `{entryId}` -> source-check report |
| `cancelCheck` | `{entryId}` -> source-check report |
| `openEntry` | `{entryId}` -> `{}`; open a locally constructed management deep link |

Sanitized entry: `{id,name,type,tags?,sourceCheck?,checkFileId?}`. Never return
master tokens, magnets, local paths or raw library entries to the extension.
The extension already owns the source it captured; responses need only summaries.

The native host accepts only the allowlisted extension origin and command schema.
No arbitrary HTTP, filesystem read, shell command, remote server URL, or app path
may be supplied by a web page or extension message. Host configuration is local
and private; the management token is read locally, never stored in the extension.

## Extension behavior

Use activeTab, scripting, contextMenus, sidePanel, storage and nativeMessaging.
No persistent all-sites access, cookies, browsing history, downloads monitoring,
remote scripts, or externally_connectable website bridge.

Capture only after a toolbar/context-menu action. Read DOM links rather than
searching sites or running their code. Multiple matches require selection.
Protected .torrent downloads remain a normal browser action, followed by file
selection/drop; do not relay credential-dependent URLs to the server.

The side panel preserves drafts and uses a service worker to own native requests.
Pending confirmations keep stable idempotency keys across suspension/retry.
Saved/check-failed states are distinct; closing the panel does not undo a save.
Progress polls only while useful and never creates a duplicate import.

## Packaging and limits

The macOS app registers the native helper during its normal startup. Development
registration is explicit so starting a checkout does not silently replace an
installed app's connection. The registration contains paths and extension ID,
not the token. Use the app's bundled Node runtime.

Chrome Web Store publication is separate from implementation and cannot be
claimed complete here. Local testing uses Load unpacked; production should use
a published listing and its stable extension public key/ID.

No source data, saved media, existing credentials or accepted ADRs are deleted.
