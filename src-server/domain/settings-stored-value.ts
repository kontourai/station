/**
 * Whether a value is a DECISION rather than the absence of one. The
 * definition lives in `@kontourai/station-contracts/config` (#4517 round 2)
 * so the CLI's offline overlay shares it; this leaf re-exports it for
 * `settings-effective.ts`, provenance and the managed overlay, which must not
 * disagree about what "absent" means.
 */
export {
  hasAppConfigStationDecision,
  isStoredValue,
} from '@kontourai/station-contracts/config';
