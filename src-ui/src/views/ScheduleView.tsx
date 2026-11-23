import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { PageSection } from '../components/PageSection';
import { PageFrameActions } from '../components/page-frame';
import { JobDetail, relTime } from '../components/scheduler';
import { jobLabel } from '../components/scheduler/jobName';
import { ErrorState, FilteredEmpty, SkeletonBlock } from '../components/state';
import { useAgents } from '../contexts/AgentsContext';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useProjects } from '../contexts/ProjectsContext';
import { schedulerJobDialogStore } from '../contexts/scheduler-job-dialog-store';
import { useToast } from '../contexts/ToastContext';
import {
  useDeleteJob,
  useRunJob,
  useRunsQuery,
  useSchedulerEvents,
  useSchedulerJobs,
  useSchedulerStatus,
  useToggleJob,
} from '../hooks/useScheduler';
import { errorText } from '../utils/errorText';
import { TableFilter } from './SortableTable';
import { statusRank } from './schedule/automationRow';
import {
  automationRowId,
  OutcomeLegend,
  type PendingRowAction,
  ScheduleAutomationList,
} from './schedule/ScheduleAutomationList';
import { ScheduleEmptyState } from './schedule/ScheduleEmptyState';
import { NextDaysTitle, ScheduleNextDays } from './schedule/ScheduleNextDays';
import { selectSchedulerFailure } from './schedule/utils';
import './ScheduleView.css';
import './page-layout.css';

/** Above this many automations the list offers a filter. */
const FILTER_ABOVE = 15;

function parseQualifiedScheduleRun(runId: string | null) {
  if (!runId?.startsWith('schedule:')) return null;
  const [, providerId, jobName, logId, ...rest] = runId.split(':');
  if (!providerId || !jobName || !logId || rest.length) return null;
  try {
    return {
      providerId: decodeURIComponent(providerId),
      jobName: decodeURIComponent(jobName),
      logId: decodeURIComponent(logId),
    };
  } catch {
    return null;
  }
}

export function ScheduleView() {
  const authority = useHostRequestAuthorityScope();
  const {
    data: jobs = [],
    isLoading,
    isError: jobsError,
    error: jobsFailure,
    refetch: refetchJobs,
    isFetching: fetchingJobs,
  } = useSchedulerJobs();
  const {
    data: status,
    isLoading: loadingStatus,
    isError: statusError,
    error: statusFailure,
    refetch: refetchStatus,
    isFetching: fetchingStatus,
  } = useSchedulerStatus();
  const { data: runs = [], isLoading: runsLoading } = useRunsQuery();
  const agents = useAgents();
  const { projects } = useProjects();
  const schedulerAvailable = !jobsError && !statusError;
  const { isRunning, markErrorShown, getMissedCount } =
    useSchedulerEvents(schedulerAvailable);
  const runJob = useRunJob();
  const toggleJob = useToggleJob();
  const deleteJob = useDeleteJob();
  const { showToast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    variant: 'danger' | 'warning';
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [retryFailure, setRetryFailure] = useState<ReturnType<
    typeof selectSchedulerFailure
  > | null>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const returnRetryFocus = useRef(false);
  useEffect(() => {
    if (retryFailure || !returnRetryFocus.current) return;
    returnRetryFocus.current = false;
    if (document.activeElement === document.body) retryButton.current?.focus();
  }, [retryFailure]);
  const [runTarget, setRunTarget] = useState(() =>
    new URLSearchParams(window.location.search).get('run'),
  );

  useEffect(() => {
    const sync = () =>
      setRunTarget(new URLSearchParams(window.location.search).get('run'));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  // Active first, then paused, then finished one-time automations; each
  // group by the name people read, never the slug.
  const orderedJobs = useMemo(() => {
    const now = Date.now();
    return [...jobs].sort(
      (left, right) =>
        statusRank(left, now) - statusRank(right, now) ||
        jobLabel(left).localeCompare(jobLabel(right)),
    );
  }, [jobs]);
  const filtering = jobs.length > FILTER_ABOVE;
  const visibleJobs = useMemo(() => {
    const query = filtering ? filterText.trim().toLowerCase() : '';
    if (!query) return orderedJobs;
    return orderedJobs.filter((job) =>
      [jobLabel(job), job.name].some((text) =>
        text.toLowerCase().includes(query),
      ),
    );
  }, [filterText, filtering, orderedJobs]);
  const projectName = useCallback(
    (id: string) => projects.find((project) => project.id === id)?.name,
    [projects],
  );

  const qualifiedRun = parseQualifiedScheduleRun(runTarget);
  const exactRun = useMemo(
    () => (runTarget ? runs.find((run) => run.runId === runTarget) : undefined),
    [runTarget, runs],
  );
  const matchedDeepLinkedJob = qualifiedRun
    ? jobs.find(
        (job) =>
          job.name === qualifiedRun.jobName &&
          job.provider === qualifiedRun.providerId,
      )
    : undefined;
  useEffect(() => {
    if (!runTarget || !matchedDeepLinkedJob) return;
    setFilterText('');
    setExpanded(
      `${matchedDeepLinkedJob.provider}:${matchedDeepLinkedJob.name}`,
    );
  }, [matchedDeepLinkedJob, runTarget]);

  // T5 / SHELL-16: a primary action the user pressed always answers, on
  // success as well as failure.
  const startRun = useCallback(
    (job: SchedulerJob) => {
      const label = jobLabel(job);
      setRunError(null);
      runJob.mutate(job.name, {
        onSuccess: () => {
          showToast(`Started a run of '${label}'.`);
        },
        onError: (e: Error) => {
          markErrorShown(job.name);
          const message = errorText(e);
          setRunError(`Failed to run '${label}': ${message}`);
          showToast(`Failed to run '${label}': ${message}`);
        },
      });
    },
    [runJob, showToast, markErrorShown],
  );

  // Pause, Resume and Delete answer the same way Run now does: a failure is
  // said on the page and in a toast, never left to a silent refetch.
  const changeJob = useCallback(
    (job: SchedulerJob, action: PendingRowAction['action']) => {
      const label = jobLabel(job);
      setRunError(null);
      const onError = (e: Error) => {
        const message = `Couldn't ${action} '${label}': ${errorText(e)}`;
        setRunError(message);
        showToast(message);
      };
      if (action === 'delete') deleteJob.mutate(job.name, { onError });
      else
        toggleJob.mutate(
          { target: job.name, enabled: action === 'resume' },
          { onError },
        );
    },
    [deleteJob, toggleJob, showToast],
  );
  const pendingAction: PendingRowAction | undefined = deleteJob.isPending
    ? { name: String(deleteJob.variables), action: 'delete' }
    : toggleJob.isPending && toggleJob.variables
      ? {
          name: toggleJob.variables.target,
          action: toggleJob.variables.enabled ? 'resume' : 'pause',
        }
      : undefined;
  // A day chip or Next up row opens its automation's row and moves there.
  const [revealJob, setRevealJob] = useState<SchedulerJob | null>(null);
  useEffect(() => {
    if (!revealJob) return;
    const row = document.getElementById(automationRowId(revealJob));
    row?.scrollIntoView?.({ block: 'center' });
    row?.querySelector<HTMLButtonElement>('.automations-row__name')?.focus();
    setRevealJob(null);
  }, [revealJob]);

  // Both scheduler reads failed. What we may say about that is derived from
  // the errors themselves, not assumed — see `selectSchedulerFailure`.
  if ((jobsError && statusError) || retryFailure) {
    const notice =
      retryFailure ?? selectSchedulerFailure(jobsFailure, statusFailure);
    return (
      <ErrorState
        className="schedule__failure"
        title={notice.title}
        description={notice.description}
        action={
          <Button
            ref={retryButton}
            disabled={Boolean(retryFailure) || fetchingJobs || fetchingStatus}
            onClick={async (event) => {
              returnRetryFocus.current =
                event.currentTarget === document.activeElement;
              setRetryFailure(notice);
              await Promise.allSettled([refetchJobs(), refetchStatus()]);
              setRetryFailure(null);
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  const providers = Object.values(status?.providers ?? {});
  // Scoped to the job actually being run: React Query reports the in-flight
  // mutation's own variables, so one job's request cannot disable every other
  // job's Run now.
  const runPendingJob = runJob.isPending
    ? (runJob.variables as string | undefined)
    : undefined;
  const rowIssues = status?.providers['built-in']?.rowIssues ?? [];

  return (
    <div className="schedule">
      {/* The header, its eyebrow and its first-run anchor are the frame's
          (SHELL-11); the action travels to the frame's action cell, as the
          one shared `Button`. */}
      <PageFrameActions>
        <Button
          variant="primary"
          size="sm"
          disabled={!authority}
          onClick={() => {
            if (authority) schedulerJobDialogStore.open({ authority });
          }}
        >
          New automation
        </Button>
      </PageFrameActions>

      {isLoading || loadingStatus ? (
        <SkeletonBlock count={4} label="Loading automations" />
      ) : (
        <>
          <SchedulerNotice
            statusError={statusError}
            providers={providers}
            onRetry={() => void refetchStatus()}
          />

          {rowIssues.length > 0 && (
            <section aria-labelledby="schedule-row-issues">
              <h2 id="schedule-row-issues">Schedules that need repair</h2>
              <ul>
                {rowIssues.map((issue) => (
                  <li key={issue.jobId}>
                    <strong>{issue.name}</strong>{' '}
                    {issue.reason === 'invalid-json'
                      ? 'The stored job cannot be decoded.'
                      : 'The stored job has invalid fields.'}{' '}
                    Contact the Station administrator with job ID {issue.jobId}{' '}
                    to recover this job.
                  </li>
                ))}
              </ul>
            </section>
          )}
          {runError && <p role="alert">{runError}</p>}

          {runTarget && !runsLoading && !exactRun && (
            <p role="status">That run is no longer available.</p>
          )}

          {exactRun && !matchedDeepLinkedJob && (
            <section aria-label="Scheduled run">
              <h2>Scheduled run</h2>
              <p>The job was removed, but this run was kept.</p>
              <JobDetail
                name={exactRun.sourceId ?? qualifiedRun?.jobName ?? ''}
                providerId={exactRun.providerId}
                autoOpenRun={runTarget}
              />
            </section>
          )}

          {jobs.length === 0 ? (
            !exactRun && (
              <ScheduleEmptyState
                onSelectTemplate={(template) => {
                  if (authority)
                    schedulerJobDialogStore.open({
                      authority,
                      prefill: template,
                    });
                }}
              />
            )
          ) : (
            <>
              <PageSection
                title={<NextDaysTitle />}
                className="automations-section"
              >
                <ScheduleNextDays
                  onOpen={(job) => {
                    setFilterText('');
                    setExpanded(`${job.provider}:${job.name}`);
                    setRevealJob(job);
                  }}
                />
              </PageSection>
              <PageSection
                title="All automations"
                className="automations-section"
                actions={<OutcomeLegend jobs={jobs} />}
              >
                {filtering && (
                  <div className="schedule__filter">
                    <TableFilter
                      value={filterText}
                      onChange={setFilterText}
                      placeholder="Filter automations…"
                    />
                  </div>
                )}
                {visibleJobs.length === 0 ? (
                  <FilteredEmpty
                    query={filterText}
                    noun="automations"
                    onClear={() => setFilterText('')}
                  />
                ) : (
                  <ScheduleAutomationList
                    jobs={visibleJobs}
                    agents={agents}
                    projectName={projectName}
                    expanded={expanded}
                    onExpand={setExpanded}
                    autoOpenRun={runTarget}
                    isRunning={isRunning}
                    getMissedCount={getMissedCount}
                    runPendingJob={runPendingJob}
                    pendingAction={pendingAction}
                    actions={{
                      onRun: startRun,
                      onPause: (job, running) => {
                        if (!running) {
                          changeJob(job, 'pause');
                          return;
                        }
                        setConfirmAction({
                          title: 'Pause automation',
                          message: `Pausing '${jobLabel(job)}' stops the run in progress.`,
                          variant: 'warning',
                          confirmLabel: 'Pause',
                          onConfirm: () => {
                            changeJob(job, 'pause');
                            setConfirmAction(null);
                          },
                        });
                      },
                      onResume: (job) => changeJob(job, 'resume'),
                      onEdit: (job) => {
                        if (authority)
                          schedulerJobDialogStore.open({ authority, job });
                      },
                      onDuplicate: (job) => {
                        if (!authority) return;
                        schedulerJobDialogStore.open({
                          authority,
                          prefill: {
                            name: `${jobLabel(job)} copy`,
                            cron: job.cron,
                            schedule: job.schedule,
                            prompt: job.prompt,
                            agent: job.agent,
                          },
                        });
                      },
                      onDelete: (job) => {
                        setConfirmAction({
                          title: 'Delete automation',
                          message: `Delete '${jobLabel(job)}'? This cannot be undone.`,
                          variant: 'danger',
                          confirmLabel: 'Delete',
                          onConfirm: () => {
                            changeJob(job, 'delete');
                            setConfirmAction(null);
                          },
                        });
                      },
                    }}
                  />
                )}
              </PageSection>
            </>
          )}
        </>
      )}
      {confirmAction && (
        <ConfirmModal
          isOpen
          title={confirmAction.title}
          message={confirmAction.message}
          variant={confirmAction.variant}
          confirmLabel={confirmAction.confirmLabel}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}

/**
 * Scheduler health, said only when it is broken: stopped, or running but
 * no longer checking for due runs on time (the stale heartbeat). A status
 * read that failed is said as that, with a retry; the list still shows.
 */
function SchedulerNotice({
  statusError,
  providers,
  onRetry,
}: {
  statusError: boolean;
  providers: ReadonlyArray<{
    running?: boolean;
    healthy?: boolean;
    lastTickAt?: string | null;
  }>;
  onRetry: () => void;
}) {
  if (statusError)
    return (
      <ErrorState
        variant="compact"
        title="Station couldn't check whether automations are running"
        action={
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    );
  if (providers.length === 0) return null;
  if (!providers.some((provider) => provider.running))
    return (
      <p className="automations-notice" role="status">
        Automations aren't running: the scheduler is stopped.
      </p>
    );
  const stale = providers.find((provider) => provider.healthy === false);
  if (!stale) return null;
  return (
    <p className="automations-notice" role="status">
      Automations aren't running on time: the scheduler last checked for due
      runs {relTime(stale.lastTickAt ?? null)}.
    </p>
  );
}
