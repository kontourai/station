// The error primitive is OWNED by `@kontourai/station-sdk` now (station#4201,
// sequencing step 1 of docs/design/pane-host-contract.md): it joined the
// published component set so extracted panes and iframe plugins can import
// the exact component the shell renders, instead of receiving it through a
// host component slot. This re-export keeps the one-family rule intact —
// shell code still imports the state family from `components/state` — while
// the direction of truth flips: the SDK owns, the shell consumes.
//
// The deep `/error-state` subpath (not the SDK barrel) keeps this module's
// graph exactly one component wide, so the many tests that mock the
// `@kontourai/station-sdk` barrel keep rendering the real primitive.
export {
  ErrorState,
  type ErrorStateProps,
} from '@kontourai/station-sdk/error-state';
