/**
 * Whether a recorded turn start carries anything a person authored: prompt
 * text that is not all whitespace, or at least one attachment.
 *
 * The one rule for three places that must agree: the Session inventory's
 * listing query (registered as a SQLite function), the exact input read, and
 * the client's parse of that read. SQLite's own `trim()` strips only spaces,
 * so a prompt of "\n" would otherwise be listed and then refused forever.
 */
export function isAuthoredInputContent(
  prompt: unknown,
  attachmentCount: number,
): boolean {
  return (
    (typeof prompt === 'string' && prompt.trim().length > 0) ||
    attachmentCount > 0
  );
}

/** The SQLite function name the event store registers for this predicate. */
export const AUTHORED_INPUT_SQL_FUNCTION = 'station_is_authored_input';
