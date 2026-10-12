import { isStationTransportFailure } from '../../utils/stationTransportFailure';

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

/** A body the client could not parse: what `Response.json()` rejects with. */
export const READ_FAILURE_UNREADABLE =
  'Station sent a response this app could not read.';
/** The request never got a response: the browser's fetch `TypeError`. */
export const READ_FAILURE_UNREACHABLE =
  'Could not reach Station. Check the connection, then try again.';

export function describeReadFailure(error: unknown): string {
  // A parse or transport failure's own message is the engine talking
  // ("Failed to execute 'json' on 'Response': Unexpected token '<'…"): true,
  // and useless to the person reading it. Name what happened instead.
  // Older WebKit rejects Response.json() with a DOMException named
  // SyntaxError, which is not an instance of the JS SyntaxError.
  if (
    error instanceof SyntaxError ||
    (error instanceof DOMException && error.name === 'SyntaxError')
  )
    return READ_FAILURE_UNREADABLE;
  // The browsers' and native transports' own phrases, from the one list.
  if (error instanceof Error && isStationTransportFailure(error))
    return READ_FAILURE_UNREACHABLE;
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return READ_FAILURE_FALLBACK;
}
