import type {
  SchedulerJob,
  SchedulerSchedule,
} from '@kontourai/station-contracts/scheduler';
import { useResourcePostureQuery } from '@kontourai/station-sdk/resource-posture';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { PageFrameActions } from '../components/page-frame';
import { JobDetail, JobFormModal } from '../components/scheduler';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useToast } from '../contexts/ToastContext';
import {
  useDeleteJob,
  useRunJob,
  useRunsQuery,
  useSchedulerEvents,
  useSchedulerJobs,
  useSchedulerProviders,
  useSchedulerStats,
  useSchedulerStatus,
  useToggleJob,
} from '../hooks/useScheduler';
import { hostPressureKind } from '../utils/resourcePosture';
import { useSortableTable } from './SortableTable';
import { ScheduleEmptyState } from './schedule/ScheduleEmptyState';
import { ScheduleJobsTable } from './schedule/ScheduleJobsTable';
import { ScheduleStats } from './schedule/ScheduleStats';
import {
  buildEnrichedSchedulerJobs,
  selectSchedulerFailure,
} from './schedule/utils';
import './ScheduleView.css';
import './page-layout.css';
import { Button } from '../components/Button';

function parseQualifiedScheduleRun(runId: string | null) {
  if (!runId?.startsWith('schedule:')) return null;
  const [, providerId, jobName, logId, ...rest] = runId.split(':');
  if (!providerId || !jobName || !logId || rest.length) return null;
  return {
    providerId: decodeURIComponent(providerId),
    jobName: decodeURIComponent(jobName),
    logId: decodeURIComponent(logId),
  };
}

export function ScheduleView() {
  const {
    data: jobs = [],
    isLoading,
    isError: jobsError,
    error: jobsFailure,
  } = useSchedulerJobs();
  const { data: stats, isLoading: loadingStats } = useSchedulerStats();
  const {
    data: status,
    isLoading: loadingStatus,
    isError: statusError,
    error: statusFailure,
  } = useSchedulerStatus();
  const { data: providers = [] } = useSchedulerProviders();
  const { data: runs = [], isLoading: runsLoading } = useRunsQuery();
// The same server-derived signal that raises the chrome capacity notice.
  const { data: resourcePosture } = useResourcePostureQuery();
  const schedulerAvailable = !jobsError && !statusError;
  const { isRunning, markErrorShown, getMissedCount } =
    useSchedulerEvents(schedulerAvailable);
  const runJob = useRunJob();
  const toggleJob = useToggleJob();
  const deleteJob = useDeleteJob();
  const { showToast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<SchedulerJob | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [prefill, setPrefill] = useState<
    | Partial<{
        name: string;
        cron: string;
        schedule: SchedulerSchedule;
        prompt: string;
      }>
    | undefined
  >(undefined);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    variant: 'danger' | 'warning';
    onConfirm: () => void;
  } | null>(null);
  const [runTarget, setRunTarget] = useState(() =>
    new URLSearchParams(window.location.search).get('run'),
  );

  useEffect(() => {
    const sync = () =>
      setRunTarget(new URLSearchParams(window.location.search).get('run'));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const enrichedJobs = buildEnrichedSchedulerJobs({ jobs, stats });

  const {
    sorted: sortedJobs,
    sortKey,
    sortDir,
    toggle,
    filterText,
    setFilterText,
  } = useSortableTable(enrichedJobs, 'lastRun', 'desc', ['name']);
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
  }, [matchedDeepLinkedJob, runTarget, setFilterText]);

 // / : failure was already acknowledged, success was not — so
// pressing Run now on a healthy job produced no feedback at all, and the
// only evidence the run happened was a row that eventually changed. Both
// outcomes get a toast; a primary action the user pressed always answers.
  const handleRun = useCallback(
    (name: string) => {
      runJob.mutate(name, {
        onSuccess: () => {
          showToast(`Started a run of '${name}'.`);
        },
        onError: (e: Error) => {
          markErrorShown(name);
          showToast(`Failed to run '${name}': ${e.message}`);
        },
      });
    },
    [runJob, showToast, markErrorShown],
  );

// Both scheduler reads failed. What we may say about that is derived from
// the errors themselves, not assumed — see `selectSchedulerFailure`.
  if (jobsError && statusError) {
    const notice = selectSchedulerFailure(jobsFailure, statusFailure);
    return (
      <ErrorState
        className="schedule__failure"
        title={notice.title}
        description={notice.description}
      />
    );
  }

  const daemonOk =
    !statusError &&
    Object.values(status?.providers || {}).some(
      (p) => (p as { running?: boolean }).running,
    );
  const schedulerHealthy =
    !statusError &&
    Object.values(status?.providers || {}).every(
      (p) => (p as { healthy?: boolean }).healthy !== false,
    );
  const lastTickAt = Object.values(status?.providers || {}).find(
    (p) => (p as { lastTickAt?: string }).lastTickAt,
  ) as { lastTickAt?: string } | undefined;
  const totalRuns = stats?.summary?.totalRuns ?? 0;
  const successRate = totalRuns > 0 ? (stats?.summary?.successRate ?? -1) : -1;
// Undefined unless the host is under the pressure that defers scheduled
// runs; the kind carries which words this posture gets (banner and Schedule
// share that derivation).
  const hostPressure = hostPressureKind(resourcePosture);
// Scoped to the job actually being run: React Query reports the in-flight
// mutation's own variables, so one job's request cannot disable every other
// job's Run button.
  const runPendingJob = runJob.isPending
    ? (runJob.variables as string | undefined)
    : undefined;

  return (
    <div className="schedule">
{/* The header, its eyebrow and its first-run anchor are the frame's
          (SHELL-11); the action travels to the frame's action cell, as the
          one shared `Button`. */}
      <PageFrameActions>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowAddForm(true)}
        >
          Add job
        </Button>
      </PageFrameActions>

      {isLoading || loadingStats || loadingStatus ? (
        <SkeletonBlock count={4} label="Loading scheduler" />
      ) : (
        <>
          <ScheduleStats
            daemonOk={daemonOk}
            jobsCount={jobs.length}
            lastTickAt={lastTickAt?.lastTickAt}
            hostPressure={hostPressure}
            schedulerHealthy={schedulerHealthy}
            statusError={statusError}
            successRate={successRate}
            totalRuns={totalRuns}
          />

          {runTarget && !runsLoading && !exactRun && (
            <p role="status">
              That scheduled run isn’t available, and Station won’t open a
              different one in its place.
            </p>
          )}

          {exactRun && !matchedDeepLinkedJob && (
            <section aria-label="Exact Scheduler receipt">
              <h2>Scheduled check receipt</h2>
              <p>The owning job was removed; its durable run remains.</p>
              <JobDetail
                name={exactRun.sourceId ?? qualifiedRun?.jobName ?? ''}
                providerId={exactRun.providerId}
                autoOpenRun={runTarget}
              />
            </section>
          )}

          {sortedJobs.length === 0 && !exactRun ? (
            <ScheduleEmptyState
              filterText={filterText}
              onClearFilter={() => setFilterText('')}
              onSelectTemplate={(template) => {
                setPrefill(template);
                setShowAddForm(true);
              }}
            />
          ) : sortedJobs.length > 0 ? (
            <ScheduleJobsTable
              autoOpenRun={runTarget}
              daemonOk={daemonOk}
              hostPressure={hostPressure}
              expanded={expanded}
              filterText={filterText}
              getMissedCount={getMissedCount}
              handleRun={handleRun}
              isRunning={isRunning}
              runPendingJob={runPendingJob}
              onDelete={(job) => {
                setConfirmAction({
                  title: 'Delete Job',
                  message: `Delete job "${job.name}"? This cannot be undone.`,
                  variant: 'danger',
                  onConfirm: () => {
                    deleteJob.mutate(job.name);
                    setConfirmAction(null);
                  },
                });
              }}
              onDuplicate={(job) => {
                setPrefill({
                  name: `${job.name}-copy`,
                  cron: job.cron,
                  schedule: job.schedule,
                  prompt: job.prompt,
                });
                setShowAddForm(true);
              }}
              onEdit={setEditingJob}
              onExpand={setExpanded}
              onFilterChange={setFilterText}
              onToggle={(job, running) => {
                if (running) {
                  setConfirmAction({
                    title: 'Cancel Running Job',
                    message: `Disabling '${job.name}' will cancel the currently running job. Continue?`,
                    variant: 'warning',
                    onConfirm: () => {
                      toggleJob.mutate({
                        target: job.name,
                        enabled: false,
                      });
                      setConfirmAction(null);
                    },
                  });
                  return;
                }

                toggleJob.mutate({
                  target: job.name,
                  enabled: !job.enabled,
                });
              }}
              sortDir={sortDir}
              sortKey={sortKey}
              sortedJobs={sortedJobs}
              toggleSort={toggle}
            />
          ) : null}
        </>
      )}
      {editingJob && (
        <JobFormModal
          job={editingJob}
          onClose={() => setEditingJob(null)}
          providers={providers}
        />
      )}
      {showAddForm && (
        <JobFormModal
          prefill={prefill}
          onClose={() => {
            setShowAddForm(false);
            setPrefill(undefined);
          }}
          providers={providers}
        />
      )}
      {confirmAction && (
        <ConfirmModal
          isOpen
          title={confirmAction.title}
          message={confirmAction.message}
          variant={confirmAction.variant}
          confirmLabel={
            confirmAction.variant === 'danger' ? 'Delete' : 'Disable'
          }
          onConfirm={confirmAction.onConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
