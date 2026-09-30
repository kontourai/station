# Developer surface

`/developer` is a lazy-loaded diagnostic workspace with **Logs, System,
Telemetry, Memory, and Archive** tabs. The [route allowlist](../../src-ui/src/app-shell/routing.ts)
is the contract: unknown tab segments are not-found rather than silently
selecting a tab. Former `/developer/storage`, `/developer/mcp`, and
`/developer/config` links redirect to Knowledge, Tools, and Settings respectively.

Monitoring remains available through legacy `/monitoring` and `/sys/monitoring`
deep links, which redirect to `/developer/telemetry`.
[DeveloperView](../../src-ui/src/views/DeveloperView.tsx) mounts the monitoring
consumer through [TelemetryTab](../../src-ui/src/views/developer/TelemetryTab.tsx)
only while that tab is selected; its other tabs do not mount that subtree.

The defaults registered by [App](../../src-ui/src/App.tsx) are Cmd/Ctrl+Shift+D
for Developer and Cmd/Ctrl+Shift+M for cycling the available dock placements.
Bindings can be customized; see
[keyboard shortcuts](../guides/keyboard-shortcuts.md) for the editor and its limits.
