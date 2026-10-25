# UI scope

Read [the module map](../docs/architecture/module-map.md) and the relevant design document before changing a surface. Keep UI state and navigation contract-driven; use canonical state primitives and the unsaved-changes guard where a view owns dirty state. Do not introduce a product claim the backing runtime cannot prove.

Use React Query for remote data fetching through the existing SDK query hooks; do not add bespoke fetch lifecycle state. Before deriving a count, status, eligibility rule or label, reuse its contract field or shared selector, and name any filtered or actionable subset explicitly. Project layout navigation must flow through canonical `setLayout`; a Project entry without a layout uses canonical `setProject`. Do not mutate local routes to bypass either seam. `useUnsavedGuard` registers dirty state with the navigation store: call canonical `navigate` directly for route changes, and reserve its explicit `guard` callback for local state changes. Wrapping a registered route in that same guard asks twice and can lose the pending action.

Cover changed user-visible behavior at the narrowest appropriate layer.

For performance or test cleanup, use the [journey profiling and mutation route](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness). Measure actual mounted behavior before changing memoization or adding caches. Prefer canonical identity keys, bounded collections, and batched I/O; preserve authority/freshness when sharing a snapshot. DOM/source-string assertions do not establish CSS layout, hit testing, or writability.

For compact value pickers, reuse `.choice-trigger`, `.choice-caret`, and `ArrowDownGlyph`; keep picker behavior in its existing owner. Use `Button` for standard actions and `Dialog` for standard dialog chrome. `ResponsiveDialogSurface` supplies behavior and geometry only; a custom consumer must own its overlay, background, and foreground styles. Preserve visible keyboard focus and 44px mobile targets. Validate shared-style changes in each affected surface, including narrow widths and both themes.

## UI definition of done

Applies to `src-ui` and the pane packages (`packages/basis-pane`, `packages/board-pane`).

- Remote data renders loading, empty, error with a recovery action that refetches, and partial (some reads failed or still pending) states.
- Render at 390 and 1440 pixels wide in both themes and open the PNGs; a passing test, stamp or commit message is not a render.
- Use these owners. Pane packages may import only published packages (`@kontourai/station-sdk` subpaths, `@kontourai/ui/react`, the host contract), never `src-ui` modules.

| Pattern | Shell (`src-ui`) | Pane packages |
| --- | --- | --- |
| Standard action | `Button` (`components/Button`) | `ActionControl` from `@kontourai/station-sdk/action-control`; not the SDK barrel `Button`, which defaults to `type="submit"` |
| Error with retry | `ErrorState` (`components/state`) with an `action`; `variant="compact"` inline | `ErrorState` from `@kontourai/station-sdk/error-state`, same props |
| Empty | `Empty`; `FilteredEmpty` when a filter hides results | `Empty` from `@kontourai/ui/react` (shell-only `FilteredEmpty`: give `Empty` a clear-filter action) |
| Loading | `SkeletonList` (rows), `SkeletonBlock` (region) | `Skeleton` from `@kontourai/ui/react` |
| Status pill or badge | `StatusBadge` or `Badge` from `@kontourai/ui/react`, not the SDK `Pill` | Same |
| Dialog | `Dialog`; `ConfirmModal` for a confirmation | `host.confirm(...)` for a confirmation; no pane dialog owner yet, so ask before adding one |
| Disclosure | `DisclosureToggle` for a folded list section | No published primitive; a native `button` with `aria-expanded` |
| Key/value, table | No primitive; semantic `dl`/`table` with `--k-*` tokens | Same |

`lint:component-style` rejects a new `role="alert"` element that holds its own button; use `ErrorState`.

Layout, touch targets and dialogs: [responsive UI](../docs/guides/responsive-ui.md). Data ownership, tones and styling: [frontend patterns](../docs/patterns/frontend.md).

## Design system

UI, brand, and product-copy rules live in `DESIGN.md` in `@kontourai/ui` (https://github.com/kontourai/ui/blob/main/DESIGN.md; also shipped at `node_modules/@kontourai/ui/DESIGN.md`). Style with the `--k-*` tokens instead of hard-coded colors, spacing, radii or font sizes, and don't resolve anything the doc marks OPEN.
