import { fuzzyScore } from '../../components/command-palette-utils';

/**
 * Rank provider choices against a search query with the command palette's
 * subsequence fuzzy scorer — one matcher for every "type to find it" surface,
 * not a second opinion about what fuzzy means. An empty query returns the
 * catalog order untouched; otherwise non-matches drop and matches sort by
 * score (name match outranks a description-only match via the scorer's own
 * prefix/boundary bonuses).
 */
export function filterProviderChoices<T>(
  query: string,
  choices: T[],
  textOf: (choice: T) => Array<string | undefined>,
): T[] {
  const q = query.trim();
  if (!q) return choices;
  return choices
    .map((choice, index) => {
      const score = Math.max(
        ...textOf(choice).map((text) => (text ? fuzzyScore(q, text) : -1)),
      );
      return { choice, score, index };
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.choice);
}
