# UI scope

Read [the module map](../docs/architecture/module-map.md) and the relevant design document before changing a surface. Keep UI state and navigation contract-driven; use canonical state primitives and the unsaved-changes guard where a view owns dirty state. Do not introduce a product claim the backing runtime cannot prove.

Use React Query for remote data fetching; do not add bespoke fetch lifecycle state. Project layout navigation must flow through canonical `setLayout`; a Project entry without a layout uses canonical `setProject`. Do not mutate local routes to bypass either seam. `useUnsavedGuard` registers dirty state with the navigation store: call canonical `navigate` directly for route changes, and reserve its explicit `guard` callback for local state changes. Wrapping a registered route in that same guard asks twice and can lose the pending action.

Run the exact focused UI tests selected by `npm run gate:for` and cover changed user-visible behavior at the narrowest appropriate layer.

For performance or test cleanup, use the [journey profiling and mutation route](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness). Measure actual mounted behavior before changing memoization or adding caches. Prefer canonical identity keys, bounded collections, and batched I/O; preserve authority/freshness when sharing a snapshot. DOM/source-string assertions do not establish CSS layout, hit testing, or writability.

For compact value pickers, reuse `.choice-trigger`, `.choice-caret`, and `ArrowDownGlyph`; keep picker behavior in its existing owner. Use `Button` for standard actions and `Dialog` for standard dialog chrome. `ResponsiveDialogSurface` supplies behavior and geometry only; a custom consumer must own its overlay, background, and foreground styles. Preserve visible keyboard focus and 44px mobile targets. Validate shared-style changes in each affected surface, including narrow widths and both themes.

## Design system

UI, brand, and product-copy rules live in `DESIGN.md` in `@kontourai/ui` (https://github.com/kontourai/ui/blob/main/DESIGN.md; also shipped at `node_modules/@kontourai/ui/DESIGN.md` from 1.13.0). Style with the `--k-*` tokens instead of hard-coded colors, spacing, radii or font sizes, and don't resolve anything the doc marks OPEN.
