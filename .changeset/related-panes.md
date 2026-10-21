---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add the optional, occurrence-bound related-pane capability for plugin panes.
`PaneRelatedPanesHost` (contracts) lets a pane open its own plugin's registered
descriptors as related panes, and reveal or close what it opened, with every
outcome a value; `useRelatedPanes` (SDK root only) is the direct-pane hook and
`createRelatedPanesPaneHost` (`@kontourai/station-sdk/workspace-pane`) the
sandboxed-frame client. A host without the capability answers `unsupported`.
`WorkspacePaneDescriptor` gains an optional, reader-compatible `relationRole`
(`destination` or `tool`), and `LayoutCatalogContribution` an optional,
server-issued `lifecycleGeneration` that a reinstall or an enablement change
replaces (identity only; older readers drop it).
