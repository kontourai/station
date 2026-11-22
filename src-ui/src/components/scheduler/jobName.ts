import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';

/** The name a person reads: the display name, or the slug when it has none. */
export function jobLabel(job: Pick<SchedulerJob, 'name' | 'displayName'>) {
  return job.displayName ?? job.name;
}

const SLUG_MAX_CHARS = 60;

/**
 * The internal slug for a new automation's plain-words name. It is never
 * shown; it only has to be valid and unused. A name with no Latin letters or
 * digits still gets one, and a name another automation's slug already has
 * gets a numbered one, so any name a person types can be saved.
 */
export function slugForJobName(
  name: string,
  taken: ReadonlySet<string> = new Set(),
  now = Date.now(),
): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/, '');
  const slug = base || `automation-${now.toString(36)}`;
  if (!taken.has(slug)) return slug;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
