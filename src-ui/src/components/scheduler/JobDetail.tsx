import type { RunStatus, RunSummary } from '@kontourai/station-contracts/runs';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useFetchRunOutputRef,
  useResolveIndeterminateJobMonitor,
  useRestartJobMonitor,
  useRunsQuery,
  useSchedulerJobs,
} from '../../hooks/useScheduler';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import {
  CheckGlyph,
  CloseGlyph,
  TimeGlyph,
  WarningGlyph,
} from '../icons/Glyph';
import { Empty, SkeletonBlock } from '../state';

/**
 * `RunStatus` is a 7-member tri-state, not a boolean: only `completed` is a
 * genuine success and only `failed`/`cancelled` are genuine failures. Every
 * other value (`queued`, `starting`, `running`, `waiting_for_approval`) is
 * still in flight — none of them are a failure, and rendering them as one
 * (the previous `status === 'completed' ? ok : fail` check did exactly that)
 * shows an in-progress or user-actionable run as already broken.
 *
 * `waiting_for_approval` is singled out as its own "attention" tone rather
 * than folded into "pending": it is the one state where the run is stalled
 * on *this user*, not on the system, so it reads differently from "still
 * running" at a glance.
 */
export function runStatusVisual(status: RunStatus): {
  tone: 'ok' | 'fail' | 'pending' | 'attention';
  label: string;
} {
  switch (status) {
    case 'completed':
      return { tone: 'ok', label: 'Completed' };
    case 'failed':
      return { tone: 'fail', label: 'Failed' };
    case 'cancelled':
      return { tone: 'fail', label: 'Cancelled' };
    case 'waiting_for_approval':
      return { tone: 'attention', label: 'Waiting for approval' };
    case 'queued':
      return { tone: 'pending', label: 'Queued' };
    case 'starting':
      return { tone: 'pending', label: 'Starting' };
    case 'running':
      return { tone: 'pending', label: 'Running' };
    default: {
      // Exhaustive by construction: adding a RunStatus without deciding its
      // tone is a COMPILE error here, not a silent default. That matters
      // because the silent default this replaces returned `pending` -- so a
      // new terminal-failure status would have rendered as "still running",
      // which is the same defect this whole change exists to remove, one
      // status later (archive#3238).
      const unhandled: never = status;
      // Runtime belt-and-braces for a value that escaped the type (a payload
      // from a newer server). `attention` rather than `pending`: an
      // unrecognised state is something to look at, never something to
      // report as calmly in-flight.
      return { tone: 'attention', label: String(unhandled) };
    }
  }
}

export function relTime(iso: string | null) {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / MS_PER_MINUTE);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * An INSTANT, in the reader's own zone.
 *
 * #1536 R1: one convention for instants across the schedule panel — this and
 * `CronPreview`'s occurrence list both render in the reader's zone with a short
 * zone label, so "Next Fire" here and "Next fires" there cannot be read as
 * disagreeing. The zone label is the part that was missing: an unlabelled local
 * time beside a rule stated in ANOTHER zone (the schedule's) invited exactly
 * that comparison. The RULE stays in the schedule's zone — see `cronToHuman`.
 */
export function localTime(iso: string | null) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function rateColor(rate: number) {
  if (rate >= 90) return 'high';
  if (rate >= 50) return 'mid';
  return 'low';
}

export function RateCell({ rate }: { rate: number | undefined }) {
  if (rate == null || rate < 0)
    return <span className="schedule__td--muted">—</span>;
  const tier = rateColor(rate);
  return (
    <span className="schedule__rate">
      <span className={`schedule__rate-value schedule__rate-value--${tier}`}>
        {rate}%
      </span>
      <span className="schedule__rate-bar">
        <span
          className={`schedule__rate-fill schedule__rate-fill--${tier}`}
          style={{ width: `${rate}%` }}
        />
      </span>
    </span>
  );
}

export function JobDetail({
  name,
  autoOpenRun,
  providerId,
}: {
  name: string;
  autoOpenRun?: string | null;
  providerId?: string;
}) {
  const { data: runs = [] } = useRunsQuery();
  const { data: jobs = [] } = useSchedulerJobs();
  const restartMonitor = useRestartJobMonitor();
  const resolveMonitor = useResolveIndeterminateJobMonitor();
  const fetchOutput = useFetchRunOutputRef();
  const [viewIdx, setViewIdx] = useState<number | null>(null);
  const [outputContent, setOutputContent] = useState<string | null>(null);
  const lastAutoFocused = useRef<string | null>(null);
  const previousAutoOpenRun = useRef(autoOpenRun);
  const focusedRunRef = useRef<HTMLTableRowElement>(null);

  const scheduleRuns = useMemo(
    () =>
      runs.filter(
        (run: RunSummary) =>
          run.source === 'schedule' &&
          run.sourceId === name &&
          (!providerId || run.providerId === providerId),
      ),
    [name, providerId, runs],
  );
  const reversedRuns = useMemo(
    () => [...scheduleRuns].reverse(),
    [scheduleRuns],
  );
  const monitor = jobs.find((job) => job.name === name)?.monitor;
  const monitorState = jobs.find((job) => job.name === name)?.monitorState;

  const handleViewOutput = useCallback(
    async (i: number) => {
      setViewIdx(i);
      setOutputContent(null);
      try {
        const run = reversedRuns[i];
        const outputRef = run.outputRef;
        if (!outputRef) {
          setOutputContent(run.failureMessage || 'No output available');
          return;
        }
        const data = await fetchOutput.mutateAsync(outputRef);
        setOutputContent(data.content);
      } catch {
        setOutputContent('Failed to load output');
      }
    },
    [fetchOutput, reversedRuns],
  );

  useEffect(() => {
    if (previousAutoOpenRun.current === autoOpenRun) return;
    previousAutoOpenRun.current = autoOpenRun;
    lastAutoFocused.current = null;
  }, [autoOpenRun]);

  useEffect(() => {
    if (
      !autoOpenRun ||
      lastAutoFocused.current === autoOpenRun ||
      !reversedRuns.length
    )
      return;
    const qualifiedLogId = autoOpenRun?.startsWith('schedule:')
      ? autoOpenRun.split(':').at(-1)
      : autoOpenRun;
    const decodedLogId = qualifiedLogId
      ? decodeURIComponent(qualifiedLogId)
      : qualifiedLogId;
    const idx = reversedRuns.findIndex(
      (run) =>
        run.runId === autoOpenRun ||
        run.metadata?.legacyLogId === decodedLogId ||
        run.outputRef?.artifactId === decodedLogId,
    );
    if (idx >= 0) {
      lastAutoFocused.current = autoOpenRun;
      focusedRunRef.current?.focus();
    }
  }, [autoOpenRun, reversedRuns]);

  const handleDownload = () => {
    if (!outputContent || viewIdx === null) return;
    const blob = new Blob([outputContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${reversedRuns[viewIdx].sourceId || 'run'}-${reversedRuns[viewIdx].attempt}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const monitorDetail = monitor ? (
    <section className="schedule__detail-monitor" aria-label="Monitor">
      <h3>Monitor</h3>
      <p>
        {monitor.kind} · {monitor.objective}
      </p>
      <p>Target: {monitor.target}</p>
      <p>
        Last probe: {monitorState?.lastOutcome ?? 'unavailable'} at{' '}
        {monitorState?.lastObservedAt ?? 'not observed'}
      </p>
      <p>
        Fingerprint:{' '}
        {monitorState?.lastTriggeredFingerprint ??
          monitorState?.lastSuccessfulFingerprint ??
          'unknown'}
      </p>
      <p>
        Task:{' '}
        {monitorState?.triggeredTaskId ? (
          <a
            href={`/projects/${monitor.projectId ?? ''}/tasks/${monitorState.triggeredTaskId}`}
          >
            {monitorState.triggeredTaskId}
          </a>
        ) : (
          'unavailable'
        )}{' '}
        · Usage: {monitorState?.usageKnown === true ? 'observed' : 'unknown'}
      </p>
      <p>
        Used: {monitorState?.completedTurns ?? 0} turns ·{' '}
        {monitorState?.consumedTokens ?? 0} tokens ·{' '}
        {monitorState?.consumedRuntimeMs ?? 0}ms
      </p>
      <p>
        Budget: {monitor.budget?.maxTurns ?? '—'} turns ·{' '}
        {monitor.budget?.maxTokens ?? '—'} tokens ·{' '}
        {monitor.budget?.maxRuntimeMs ?? '—'}ms
      </p>
      <p>
        Next action:{' '}
        {monitorState?.nextAction ?? 'Observe the next scheduled probe.'}
      </p>
      {monitorState?.usageKnown === false ? (
        <>
          <p className="schedule__monitor-resolution" role="status">
            Task usage is indeterminate. Station will resolve only the stored
            Task/session/turn receipt once its authoritative terminal usage is
            available.
          </p>
          {monitorState.triggerId ? (
            <Button
              onClick={() => {
                const triggerId = monitorState.triggerId;
                if (triggerId)
                  resolveMonitor.mutate({ target: name, triggerId });
              }}
              disabled={resolveMonitor.isPending}
            >
              Resolve from Task evidence
            </Button>
          ) : null}
        </>
      ) : null}
      {monitorState?.lastOutcome === 'terminal' &&
      monitorState.usageKnown !== false ? (
        <Button
          onClick={() => restartMonitor.mutate(name)}
          disabled={restartMonitor.isPending}
        >
          Restart monitor
        </Button>
      ) : null}
    </section>
  ) : null;

  // empty-state action: run history appears after the scheduled job runs
  if (!reversedRuns.length)
    return (
      <>
        {monitorDetail}
        <Empty variant="compact" label="No run history" />
      </>
    );

  return (
    <div className="schedule__detail-logs-wrap">
      {monitorDetail}
      <table className="schedule__logs">
        <thead>
          <tr>
            <th>Started At</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Missed</th>
            <th>Type</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {reversedRuns.map((r, i: number) => {
            const visual =
              r.metadata?.schedulerState === 'indeterminate'
                ? ({ tone: 'attention', label: 'Indeterminate' } as const)
                : runStatusVisual(r.status);
            const focused = r.runId === autoOpenRun;
            const StatusGlyph =
              visual.tone === 'ok'
                ? CheckGlyph
                : visual.tone === 'fail'
                  ? CloseGlyph
                  : visual.tone === 'attention'
                    ? WarningGlyph
                    : TimeGlyph;
            return (
              <tr
                key={r.runId}
                ref={focused ? focusedRunRef : undefined}
                className={focused ? 'schedule__log--focused' : undefined}
                data-run-id={r.runId}
                tabIndex={focused ? -1 : undefined}
              >
                <td>
                  {new Date(r.startedAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </td>
                {/* No aria-label/title here: the status word is now visible
                    text inside the cell, and an element name overrides its
                    contents — labelling this "Failed" would have hidden the
                    failure reason beside it from assistive technology. */}
                <td
                  className={`schedule__log-status schedule__log-status--${visual.tone}`}
                >
                  <span className="schedule__status-pill">
                    <StatusGlyph />
                    <span>{visual.label}</span>
                  </span>
                  {r.failureMessage && (
                    <span className="schedule__failure-reason">
                      {r.failureMessage}
                    </span>
                  )}
                </td>
                <td>
                  {typeof r.metadata?.durationSecs === 'number'
                    ? `${r.metadata.durationSecs.toFixed(1)}s`
                    : '-'}
                </td>
                <td>
                  {(r.metadata?.missedCount as number | undefined) || '-'}
                </td>
                <td>
                  {r.metadata?.manual ? 'manual' : 'cron'}
                  {r.attempt > 1
                    ? ` (retry ${r.attempt - 1}/${(r.maxAttempts ?? 1) - 1})`
                    : ''}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => handleViewOutput(i)}
                    disabled={
                      (!r.outputRef && !r.failureMessage) ||
                      (fetchOutput.isPending && viewIdx === i)
                    }
                    className="schedule__action-btn"
                  >
                    Output
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {viewIdx !== null && (
        // Was a hand-rolled overlay: no focus trap, no Escape, no focus
        // restoration — a dialog in appearance only. On the shared `Dialog` it
        // gets all three, plus the one dialog chrome (SHELL-02).
        <Dialog
          eyebrow="Schedule"
          title={`${name} — Run Output`}
          closeLabel="Close run output"
          onClose={() => setViewIdx(null)}
          size="lg"
          footer={
            <Button
              variant="primary"
              onClick={handleDownload}
              disabled={!outputContent}
            >
              Download
            </Button>
          }
        >
          {outputContent === null ? (
            <SkeletonBlock count={3} label="Loading run output" />
          ) : (
            <pre className="schedule__output-modal-body">{outputContent}</pre>
          )}
        </Dialog>
      )}
    </div>
  );
}
