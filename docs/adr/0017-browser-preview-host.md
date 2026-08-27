# Keep browser-preview hosting adapter-local

## Context

Station has a versioned Workspace Pane `1.0` contract. Descriptors and
instances carry portable identity, renderer reference, placement, context,
lifecycle, and an optional alternative renderer declaration. Native window or
webview handles, geometry, focus, z-order, process identity, and preview-store
references are adapter-local runtime mechanics.

Station currently pins `tauri = "=2.11.5"` and `tauri-build = "=2.6.3"`.
The current native capability report describes `local-browser-preview` as
enabled on desktop and unsupported on mobile; this report is not a production
browser-preview host. This spike must not attach a host to that capability or
change any release configuration.

The audited t3code snapshot is `c2f8cb7ca` (remote main later advanced to
`be01b287`): Electron `41.5.0`, a hardened
partitioned `webviewTag` preview path, and `WebContentsView`-specific
interaction handling. Its host is useful evidence, not an implementation to
copy. Electron documents `WebContentsView` as the embedded-content API for a
separately justified future migration.

## Decision

1. Keep this slice production-inert. It adds no descriptor, registry entry,
   capability activation, host command, Tauri feature, or package change.
2. Retain the external open action as the current cross-platform behavior.
3. Record stable, separate Tauri `WebviewWindow` as a future desktop candidate.
   It must consume the current Pane descriptor/instance identities and receive
   an approved target separately from persisted Pane data.
4. Keep Tauri child webviews compile-only. They require `unstable`; open
   z-order and Wayland-bounds reports make them unsuitable for a shipping
   selection.
5. Do not migrate Station to Electron for this feature. Any independently
   approved migration must define its own security, packaging, and maintenance
   decision and use `WebContentsView`, not a copied `webviewTag` design.
6. Treat Web/PWA, Android, and iOS as separate renderer or external-open
   decisions. They do not inherit desktop support.

## Consequences

- A future host rebuilds runtime state after close or crash from current Pane
  identities and a newly approved target; it never restores handles or geometry.
- A production follow-up must define a versioned migration or reset policy if
  it changes any persisted Pane state. This spike introduces neither.
- Every package, input, storage, navigation, permissions, resource, signing,
  and interaction row not cited as a command result remains `NOT_VERIFIED`.

## Evidence

The candidate matrix, experiments, current upstream record, and follow-up
criteria are in [Browser-preview host spike](../design/browser-preview-host-spike.md).
