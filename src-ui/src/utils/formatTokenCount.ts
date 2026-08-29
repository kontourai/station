/**
 * #765 A8: compact token-count formatting for collapsed one-line surfaces.
 *
 * A bare "50856 tokens" beside a one-line answer reads as a cost bomb;
 * "50.9k" reads as the magnitude it is. Counts under 1000 render exactly.
 * One decimal up to 100 of a unit ("50.9k"), whole numbers above ("251k"),
 * and a value that rounds to 1000 of its unit carries into the next
 * ("999,960" → "1M", never "1000k"). Exact figures stay available to
 * callers via {@link exactTokenCount} for tooltips and detail rows.
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || Math.abs(count) < 1000) return String(count);
  const negative = count < 0;
  let value = Math.abs(count);
  const units = ['k', 'M', 'B'] as const;
  let unitIndex = -1;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  let text = value.toFixed(value >= 100 ? 0 : 1);
  if (Number.parseFloat(text) >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
    text = value.toFixed(value >= 100 ? 0 : 1);
  }
  text = text.replace(/\.0$/, '');
  return `${negative ? '-' : ''}${text}${units[unitIndex]}`;
}

/** The exact figure, grouped for readability — tooltip/detail companion. */
export function exactTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}
