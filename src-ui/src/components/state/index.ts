// Canonical Empty/Loading/Error state family (#192). Import from here rather
// than reaching directly into `@kontourai/ui/react` or `../Skeleton` so every
// migrated surface shares one discoverable entry point.
//
// - `Empty` — Console Kit's own primitive, already Station's canonical empty
//   state answer; re-exported (not reinvented) per the consume-never-fork
//   rule.
// - `ErrorState` — Console Kit ships no error primitive, so this wraps
//   `Empty` with a fixed error affordance (icon + retry `action` slot). It is
//   OWNED by `@kontourai/station-sdk` (published component set, archive#4201)
//   and re-exported here; shell code keeps importing it from this barrel.
// - `Skeleton`/`SkeletonList`/`SkeletonBlock` — re-exported from the existing
//   `../Skeleton` module (itself already a thin Console Kit `Skeleton`
//   wrapper) so loading state lives under the same barrel. `SkeletonList` is
//   the row-shaped wait, `SkeletonBlock` the region-shaped one; between them
//   they are the ONLY loading vocabulary a view should reach for. A new
//   "Loading X..." string is a regression (SHELL-13).
//
// Recorded, reasoned exceptions (not migrated, not gaps — see CLAUDE.md
// "State primitives"): `FullScreenLoader`/`FullScreenError`
// (`@kontourai/station-sdk`, boot-level splash) and `LoadingDots`
// (`../LoadingDots`, active-generation indicator).

export {
  Skeleton,
  SkeletonBlock,
  type SkeletonBlockProps,
  SkeletonList,
  type SkeletonListProps,
  type SkeletonProps,
} from '../Skeleton';
export {
  describeReadFailure,
  READ_FAILURE_FALLBACK,
} from './describeReadFailure';
export { Empty, type EmptyProps } from './Empty';
export { ErrorState, type ErrorStateProps } from './ErrorState';
export { FilteredEmpty } from './FilteredEmpty';
