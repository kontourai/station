import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import {
  useProjectSchedulesCapability,
  useSchedulerJobs,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import {
  cronToHuman,
  formatSchedule,
  JobFormModal,
  localTime,
  scheduleForJob,
} from '../../components/scheduler';
import { jobLabel } from '../../components/scheduler/jobName';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { userFacingErrorMessage } from '../../utils/errorText';
import { automationStatus } from '../schedule/automationRow';

/** The scheduled jobs that belong to one Project (#5070). */
export function projectJobs(
  jobs: readonly SchedulerJob[] | undefined,
  projectId: string,
): SchedulerJob[] {
  return (jobs ?? []).filter((job) => job.projectId === projectId);
}

/** A schedule in words, as the Automations page states a cron rule. */
function scheduleLabel(job: SchedulerJob): string {
  const schedule = scheduleForJob(job);
  return (
    (schedule.kind === 'cron' &&
      cronToHuman(schedule.expr, { timezone: schedule.timezone })) ||
    formatSchedule(schedule)
  );
}

/**
 * The same state words as Automations (Paused, Done), then what an active
 * schedule does next: it waits while the Project is held.
 */
function projectScheduleStatus(
  job: SchedulerJob,
  held: boolean,
): string | undefined {
  const status = automationStatus(job, false, Date.now());
  if (status !== 'Active') return status;
  if (held) return 'Waiting';
  return job.nextRun ? `Next ${localTime(job.nextRun)}` : undefined;
}

export function ProjectSchedulesSection({
  projectId,
  projectName,
  held,
}: {
  projectId: string;
  projectName: string;
  /** Paused or archived: its schedules wait. */
  held: boolean;
}) {
  const jobsQuery = useSchedulerJobs();
  // An older Station would create a plain job, so creating one waits for
  // the Station to say it runs Project schedules.
  const supported = useProjectSchedulesCapability().data === true;
  const [creating, setCreating] = useState(false);
  const jobs = projectJobs(
    jobsQuery.data as SchedulerJob[] | undefined,
    projectId,
  );

  return (
    <PageSection
      id="section-schedules"
      className="project-settings__section"
      title="Schedules"
      description={
        held
          ? 'This Project is paused, so its schedules wait until you resume it.'
          : 'Each run starts a Task here with the Task brief.'
      }
      actions={
        supported ? (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            New schedule
          </Button>
        ) : undefined
      }
    >
      {jobsQuery.isPending ? (
        <SkeletonList count={2} label="Loading schedules" />
      ) : jobsQuery.isError ? (
        <ErrorState
          variant="compact"
          title="Could not load schedules"
          description={userFacingErrorMessage(jobsQuery.error)}
          action={
            <Button onClick={() => void jobsQuery.refetch()}>Retry</Button>
          }
        />
      ) : jobs.length === 0 ? (
        <Empty
          label="Schedule recurring work"
          description="Each run starts a Task here, such as a Monday digest."
        />
      ) : (
        jobs.map((job) => (
          <PageRow
            key={job.name}
            label={jobLabel(job)}
            description={scheduleLabel(job)}
            status={projectScheduleStatus(job, held)}
          />
        ))
      )}
      {creating && (
        <JobFormModal
          project={{ id: projectId, name: projectName }}
          onClose={() => setCreating(false)}
        />
      )}
    </PageSection>
  );
}
