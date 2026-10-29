/**
 * Whether a recorded turn start carries anything a person authored: prompt
 * text that is not all whitespace, or at least one attachment.
 *
 * The one rule for three places that must agree: the event store's input
 * readability rule (which the Session inventory listing runs as a SQLite
 * function and the exact input read applies), and the client's parse of that
 * read. SQLite's own `trim()` strips only spaces, so a prompt of "\n" would
 * otherwise be listed and then refused forever.
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
