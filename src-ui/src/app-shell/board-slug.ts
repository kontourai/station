/**
 * A slug this viewer is not already using, derived from the default name.
 *
 * The slug is the Board's ADDRESS (the filename on disk and the segment in
 * its URL), and the server refuses a repeat with 409. Deriving a free one
 * here means the `+` always produces a Board rather than an error the user
 * did not ask a question to receive; the NAME stays the friendly duplicate
 * ("Untitled Board" twice is fine) because the name is not an identity.
 */
export function nextBoardSlug(taken: readonly string[]): string {
  const base = 'untitled-board';
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * #4405 (A28): the address a new Board's first name gives it — lowercase
 * words joined by `-`, starting with a letter, at most 64 characters (the
 * server's slug rule) — made free among `taken` the way `nextBoardSlug` is.
 * `undefined` when the name has nothing an address can use.
 */
export function boardSlugFromName(
  name: string,
  taken: readonly string[],
): string | undefined {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!words) return undefined;
  const base = (/^[a-z]/.test(words) ? words : `board-${words}`)
    .slice(0, 56)
    .replace(/-+$/, '');
  if (!taken.includes(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}
