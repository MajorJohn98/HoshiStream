# 0024 - Immutable pointer Blob versions

Status: accepted (2026-09-12).

Amends the Blob storage path of [ADR 0013](0013-multi-tenant-pointer-server.md).
Record identity (token hash), ownership (push-secret hash), the Redis path, and
the manual-push contract are unchanged.

## Context

The Vercel Blob backend stored each tenant's record at one fixed pathname and
overwrote it in place on every push. Blob reads go through Vercel's CDN, which
ignores cache-busting query strings and does not reliably honour the 60 s
`Cache-Control` the record was written with. In production the relay served a
record that had been overwritten four days earlier, so pushes were acknowledged
as successful while every redirect still pointed at the previous LAN address.
The installed app could not notice: its local state was truthful (the server
did accept the push), and only `remoteStatus()` would have exposed the mismatch.

The SDK's origin read (`get(..., { useCache: false })`) is a no-op on a public
store — it is only implemented for private-access stores, which would require
provisioning a new store and rotating the token.

## Decision

- Never overwrite a pointer record in place. Each push writes a new immutable
  blob under the tenant prefix `hoshistream-pointer-v3/<tokenHash[:32]>/`,
  named by zero-padded epoch milliseconds plus a random tail, so the newest
  version is the lexicographically greatest pathname.
- Locate the current version with the Blob `list` API, which is a control-plane
  call and not a CDN read. Reading a fresh pathname is always a CDN miss, so the
  content is exactly what was written.
- Delete superseded versions and the tenant's retired in-place `v2` blob
  best-effort after a successful push; cleanup failure never fails the push or
  the redirect. Deletion of a record removes every version plus the `v2` blob.
- Keep reading the `v2` pathname only when no `v3` version exists, so tenants
  that have not pushed since this rollout keep resolving (possibly stale) until
  their next manual push replaces the record.
- Keep the 10 s in-memory cache; a push still becomes visible within seconds.

## Consequences

- One `list` call plus one blob read per uncached lookup instead of one `head`
  plus one fetch. Pushes are rare and manual, so the extra API calls are noise.
- A tenant's storage may briefly hold two versions between a push and its
  cleanup, or longer if cleanup fails; the newest pathname wins regardless.
- Existing tenants must push once from the app to move onto `v3`; there is no
  server-side migration.
- The Blob store stays public. A private store would allow true origin reads
  but is a separate operational change and is not required for correctness.
