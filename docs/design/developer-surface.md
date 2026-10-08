# Developer surface

`/developer` is a lazy-loaded diagnostic workspace with **Logs, System,
Monitoring, Memory, and Archive** sections. Settings and Developer use the same
[section navigation](../../src-ui/src/components/SectionNavigation.tsx): a desktop
rail and a narrow-screen selector. The [route allowlist](../../src-ui/src/app-shell/routing.ts)
is the contract: unknown tab segments are not-found rather than silently
selecting a tab. Former `/developer/storage`, `/developer/mcp`, and
`/developer/config` links redirect to Knowledge, Tools, and Settings respectively.

Monitoring remains available through legacy `/monitoring` and `/sys/monitoring`
deep links, which redirect to `/developer/telemetry`.
[DeveloperView](../../src-ui/src/views/DeveloperView.tsx) mounts the monitoring
consumer through [TelemetryTab](../../src-ui/src/views/developer/TelemetryTab.tsx)
only while that tab is selected; its other tabs do not mount that subtree.

[Logs](../../src-ui/src/views/developer/LogsTab.tsx) exposes optional five-second
refresh, text/level filters, explicit time bounds, structured records, and scan
coverage. Refresh is off initially. Records retain the server's redaction policy.

[System](../../src-ui/src/views/developer/SystemTab.tsx) separates instance and
restart facts from [Performance](../../src-ui/src/views/developer/SystemPerformance.tsx)
and [Services](../../src-ui/src/views/developer/SystemServices.tsx). Performance
plots up to 60 received host CPU/memory samples while mounted and reports Station
process RSS/heap separately. It is diagnostic only. Services displays the
existing engine, capability, developer-service and ACP projections, including
unavailable reasons and discovery freshness. Ready means the projection's
readiness observation, not successful execution of a turn.

Monitoring separates Activity, Tool latency, Usage, Context, and Routing.
Activity keeps the event explorer and adds expandable current session diagnostics.
Tool latency uses only measured result events in the loaded, filtered window;
truncated or unreadable history is marked partial. Usage reuses the receipt
rollup and operator Station overview rather than process-lifetime direct-chat
metrics. Context reads the selected conversation's statistics, reporting missing
occupancy explicitly. Routing keeps both inference receipt readers. Their time
windows and scope are owned by the respective readers, not the activity filter.

The route remains `/developer/telemetry` for compatibility. Monitoring has one
page title; its embedded body publishes connection and session status without
another page heading. See [monitoring](../guides/monitoring.md) for data sources
and collection limits.

The defaults registered by [App](../../src-ui/src/App.tsx) are Cmd/Ctrl+Shift+D
for Developer and Cmd/Ctrl+Shift+M for cycling the available dock placements.
Bindings can be customized; see
[keyboard shortcuts](../guides/keyboard-shortcuts.md) for the editor and its limits.
