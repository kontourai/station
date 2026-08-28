/**
 * The one sentence a failed READ is allowed to show the user.
 *
 * Review found the same defect in three unrelated places — a query error
 * settling with no data, then being drawn as "No installed skills yet" / "Add
 * a provider to get started" / "No stats available". The fix is the same
 * everywhere (render `ErrorState` before the empty branch), so the copy
 * derivation is shared rather than retyped per view: one fact, one derivation.
 *
 * A thrown `Error`'s message is the most specific thing we honestly know, so
 * it is preferred. Anything else (a string, a rejected non-Error, `true`) has
 * no message worth showing, so this falls back to a sentence that claims
 * nothing about the cause.
 */
export const READ_FAILURE_FALLBACK = 'Try again in a moment.';

export function describeReadFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return READ_FAILURE_FALLBACK;
}
