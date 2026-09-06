# 0020 - Manual import with a Chrome companion

Status: accepted (2026-09-06).

## Context

The owner rejected in-app torrent searching as too difficult for nontechnical
users and approved replacing it with manual adding assisted by a Chrome extension.
The first version targets Chrome and HoshiStream on the same macOS computer.

This supersedes the active search-provider direction in ADRs 0016-0018. Their
historical records and existing library entries remain unchanged.

## Decision

Remove discovery providers, indexer configuration and the in-app Search UI.
Keep durable manual import, torrent validation, source checks, source identity,
and explicit series-overlap review. Provider-neutral import drafts replace
search-result IDs. Preserve legacy provenance/receipts needed by saved entries.

The Manifest V3 companion uses a side panel, explicit toolbar/context-menu
capture, temporary activeTab access, manual magnet input and .torrent file
selection. It does not search sites, read browsing history, export cookies,
monitor all downloads, execute page code, or request persistent all-sites access.

Use Chrome Native Messaging through a helper bundled with the macOS app. The
app registers the helper for its exact extension ID. The helper reads the local
token and configured port, relays only allowlisted commands, and returns sanitized
summaries. The token, local paths and full library entries never enter extension
responses. No browser-supplied command, filesystem path or server URL is executed.

Draft preparation and commit are separate, bounded and retry-safe. The extension
retains confirmation identity before sending. App-side checks remain separate
from saving; a failed check does not turn a successful Add into a retrying create.

## Consequences

Normal use needs the HoshiStream app plus its Chrome companion, not Jackett,
Prowlarr or provider configuration. The macOS app registers its helper on launch;
development registration is explicit and does not happen on every dev-server run.

Chrome Web Store publication and its final public key/ID remain release work.
Local testing uses an unpacked extension with a stable development identity.
Windows, LAN-server connections, automatic site downloads and protocol-handler
takeover are out of scope for this version.

The browser handles normal site interaction. Unavailable swarms, invalid torrent
metadata and incompatible video still require honest check results and recovery.
