import { createHash } from 'node:crypto';

/** Stable JSON identity shared by finding and receipt producers. */
export function canonicalReviewJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalReviewJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalReviewJson(entry)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function reviewEvidenceId(value: unknown): string {
  return createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
}
