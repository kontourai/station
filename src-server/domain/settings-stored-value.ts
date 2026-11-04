/**
 * Whether a value is a DECISION rather than the absence of one.
 *
 * archive#1557 review fix (M4): the resolvers trim and treat a whitespace-only
 * string as absent. Provenance used a bare truthiness test, so `AWS_REGION="  "`
 * made Settings report "Set by operator: AWS_REGION" for a value the resolver
 * discards — the surface re-deriving "absent" for itself, which is the entire
 * thing the shared resolver exists to stop.
 *
 * Shared by `settings-effective.ts` (#2144 slice 2), provenance and the
 * managed overlay (#4517). An effective-value
 * resolver and a provenance builder that disagreed about what "absent" means
 * would report a source for a value the other one discards, which is the
 * defect this predicate was written to fix in the first place.
 */
export function isStoredValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}
