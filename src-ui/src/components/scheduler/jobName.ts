import {
  type SchedulerJob,
  schedulerJobSlugCandidates,
} from '@kontourai/station-contracts/scheduler';

/** The name a person reads: the display name, or the slug when it has none. */
export function jobLabel(job: Pick<SchedulerJob, 'name' | 'displayName'>) {
  return job.displayName ?? job.name;
}

/**
 * The slug the form names for a host that cannot pick one itself (it has no
 * `schedulerJobDisplayName`): the first of the scheduler's own candidates
 * that none of `taken` has. `taken` is only the jobs this person can see, so
 * that host may still refuse it.
 */
export function slugForJobName(
  name: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const candidates = schedulerJobSlugCandidates(name);
  return (
    candidates.find((candidate) => !taken.has(candidate)) ?? candidates[0]!
  );
}
