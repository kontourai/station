/**
 * Human presentation for an immutable Station artifact build timestamp.
 *
 * This is deliberately a formatter, not a source of provenance: callers must
 * provide the timestamp that their packaged artifact carries. In particular,
 * it must not substitute a provider upload date, file mtime, or ambient
 * environment value when the artifact has no stamp.
 */
export type BuildTimestampState =
  | 'available'
  | 'development'
  | 'missing'
  | 'invalid';

export type BuildTimestampPresentation = Readonly<{
  state: BuildTimestampState;
  /** Canonical UTC timestamp when the artifact supplied one. */
  utc?: string;
  /** Short, human age suitable for compact chrome. */
  age?: string;
  /** Human UTC date suitable for details and accessibility text. */
  date?: string;
  /** Full accessible description, including date and age. */
  description: string;
}>;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export function formatBuildAge(ageSeconds: number): string {
  const seconds = Math.max(0, Math.floor(ageSeconds));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (days < 60) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Formats only a real ISO date in UTC. Values accepted by `Date.parse` but
 * lacking an explicit zone are rejected so local-time ambiguity can never be
 * presented as immutable artifact provenance.
 */
export function formatArtifactBuildTimestamp(
  builtAt: unknown,
  {
    nowMs = Date.now(),
    development = false,
  }: { nowMs?: number; development?: boolean } = {},
): BuildTimestampPresentation {
  if (builtAt === undefined || builtAt === null || builtAt === '') {
    return development
      ? {
          state: 'development',
          description:
            'Development build; immutable build timestamp unavailable.',
        }
      : {
          state: 'missing',
          description: 'Build timestamp unavailable.',
        };
  }
  if (
    typeof builtAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(builtAt)
  ) {
    return { state: 'invalid', description: 'Build timestamp is invalid.' };
  }
  const parsed = Date.parse(builtAt);
  if (!Number.isFinite(parsed) || !Number.isFinite(nowMs)) {
    return { state: 'invalid', description: 'Build timestamp is invalid.' };
  }
  const date = new Date(parsed);
  const utc = date.toISOString();
  // Date.parse normalizes impossible calendar dates (such as February 31).
  // Accept a no-fraction input only when it canonically means `.000Z`.
  const canonicalInput = builtAt.includes('.')
    ? builtAt
    : builtAt.replace(/Z$/, '.000Z');
  if (utc !== canonicalInput) {
    return { state: 'invalid', description: 'Build timestamp is invalid.' };
  }
  const dateLabel = `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')}, ${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
  const age = formatBuildAge(Math.max(0, Math.floor((nowMs - parsed) / 1_000)));
  return {
    state: 'available',
    utc,
    age,
    date: dateLabel,
    description: `Built ${dateLabel} (${age}); canonical UTC timestamp ${utc}.`,
  };
}
