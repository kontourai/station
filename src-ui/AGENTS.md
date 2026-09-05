# UI scope

Read [the module map](../docs/architecture/module-map.md) and the relevant design document before changing a surface. Keep UI state and navigation contract-driven; use canonical state primitives and the unsaved-changes guard where a view owns dirty state. Do not introduce a product claim the backing runtime cannot prove.

Use React Query for remote data fetching; do not add bespoke fetch lifecycle state. Project navigation changes must flow through the canonical `setLayout` seam, not local route mutation.

Run the exact focused UI tests selected by `npm run gate:for` and cover changed user-visible behavior at the narrowest appropriate layer.

For performance or test cleanup, use the [journey profiling and mutation route](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness). Measure actual mounted behavior before changing memoization or adding caches. Prefer canonical identity keys, bounded collections, and batched I/O; preserve authority/freshness when sharing a snapshot. DOM/source-string assertions do not establish CSS layout, hit testing, or writability.
