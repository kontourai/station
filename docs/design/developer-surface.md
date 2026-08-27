# Developer surface

`/developer` is a lazy-loaded diagnostic workspace with logs, system, telemetry,
storage, MCP, memory, config, and archive tabs. The tab allowlist is the route
contract: unknown tab segments are not-found rather than silently selecting a tab.

Monitoring remains available through legacy `/monitoring` and `/sys/monitoring`
deep links, which redirect to `/developer/telemetry`. Telemetry is the sole
mounted owner of the monitoring consumer, so its singleton SSE stream is not
started while another Developer tab is visible. Cmd+Shift+D opens `/developer`;
the dock-mode cycle uses the distinct Cmd+Shift+M chord so both global actions
remain reachable.
