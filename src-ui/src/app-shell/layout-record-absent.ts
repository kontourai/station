import { StationHttpError } from '@kontourai/station-sdk';

/**
 * Whether `useProjectLayoutQuery` answered "not found" — the 404 the API
 * actually returned, not a request still in flight and not a transport
 * failure.
 *
 * Extracted from `LayoutView` (#2065) rather than restated: two readers now
 * turn on this answer, and a second hand-written copy is one that eventually
 * disagrees. `LayoutView` renders "Layout not found" from it;
 * `ProjectLayoutRenderer` reaches it through `isUnplacedLayoutRecord` below.
 *
 * `StationHttpError.status` is the derivation. The message check is the
 * compatibility tail for a response that is NOT a non-2xx: on a 200 carrying
 * `{"success":false,...}`, `unwrapProjectResponse`
 * (`packages/sdk/src/client/project-response.ts`) throws a plain `Error` with
 * the envelope's message and no status at all. It is what `LayoutView` read
 * before this extraction, kept so `LayoutView`'s verdict is unchanged.
 */
export function isLayoutRecordAbsent(
  error: unknown,
  loading: boolean,
): boolean {
  if (loading) return false;
  if (error instanceof StationHttpError) return error.status === 404;
  return (
    error instanceof Error && error.message.toLowerCase().includes('not found')
  );
}

/**
 * Whether the Project exists and simply has no layout under this slug — the
 * strictly narrower claim `ProjectLayoutRenderer` needs before it substitutes
 * an unplaced builtin layout kind for a persisted record (#2065).
 *
 * Narrower because `projects.ts`' `projectReadFailure` answers **404 for both**
 * "Layout not found" and "Project not found": a link into a deleted or renamed
 * Project is a 404 too, and substituting there would render an empty Review
 * workbench for a Project that does not exist instead of saying so. The two
 * are cheap to tell apart — the envelope names the missing resource, and
 * `StationHttpError` carries that text as its message — so this distinguishes
 * rather than disclosing the conflation.
 *
 * Deliberately a SEPARATE predicate instead of tightening the one above:
 * `LayoutView` shows an error either way, so narrowing its input would change
 * a missing Project from its "Layout not found" page to the generic failure
 * page for no gain. Only the substitution decision needs the stronger claim,
 * and only the substitution decision gets it.
 */
export function isUnplacedLayoutRecord(
  error: unknown,
  loading: boolean,
): boolean {
  if (!isLayoutRecordAbsent(error, loading)) return false;
  // Absent-because-the-PROJECT-is-absent is not an unplaced layout. Matched
  // on the resource the server names, not on the whole message, so a future
  // suffix ("Project not found: alpha") still reads as a missing Project.
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return !message.includes('project not found');
}
