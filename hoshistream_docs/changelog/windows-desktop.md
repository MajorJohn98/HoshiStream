# Windows desktop implementation

Date: 2026-09-06
Status: implemented candidate; Windows acceptance and redistribution review pending

- Added a self-contained .NET Windows Forms tray shell with native menu
  actions, single-instance activation, owned-process cleanup, login integration,
  activity-scoped sleep prevention and process-resource sampling.
- Added Windows file/folder dialogs over private named pipes, preserving
  expiring selection grants, in-place links and relinking.
- Extended marker-based storage to Windows drive rediscovery. Added Windows
  filename/collision safeguards without rejecting existing POSIX registrations
  or unrelated excluded copy selections.
- Added pinned bundled mpv packaging and exercised source/built binary lookup
  and IPC contracts. Updated Windows FFmpeg to a retained, verified month-end
  build; macOS binary pins are unchanged.
- Added Windows Chrome native messaging, token-free activation handoff through
  Explorer and private stdin, custom-state support, and opt-in magnet
  capabilities with explicit import review.
- Replaced PID-only startup/force-stop assumptions with real readiness,
  exclusive state ownership and authenticated local shutdown. Added cleanup
  for startup failures and in-flight speed measurements.
- Added shared installer/ZIP staging, Inno Setup maintenance, ownership-safe
  integration removal, private-data exclusion and Windows CI.
- Updated onboarding, media and Status wording for both desktop platforms.

The local Windows payload is produced by
`node packaging/build-windows-app.mjs --stage-only`.
The implementation does not claim that interactive Windows behavior has
been exercised on this macOS development host. Distributable builds remain
gated on the exact third-party source/license review described in the
[Windows distribution guide](../guides/distributing-windows-app.md).
