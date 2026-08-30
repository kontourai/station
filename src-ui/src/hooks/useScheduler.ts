/**
 * Scheduler hooks — integration for Schedule view
 *
 * Query/mutation hooks are re-exported from @kontourai/station-sdk.
 * SSE event handling stays local (UI-specific: toast, navigation).
 */

import type {
  SchedulerEvent,
  SchedulerFormField,
  SchedulerProviderStats,
  SchedulerProviderStatus,
} from '@kontourai/station-contracts/scheduler';
import { type FetchSseConnection, fetchSSE } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useToast } from '../contexts/ToastContext';

export type { SchedulerEvent } from '@kontourai/station-contracts/scheduler';
// Re-export SDK hooks so existing imports from '../hooks/useScheduler' keep working
export {
  useAddJob,
  useDeleteJob,
  useEditJob,
  useFetchRunOutputRef,
  usePreviewSchedule,
  useResolveIndeterminateJobMonitor,
  useRestartJobMonitor,
  useRunJob,
  useRunsQuery,
  useSchedulerJobs,
  useSchedulerProviders,
  useSchedulerStats,
  useSchedulerStatus,
  useToggleJob,
} from '@kontourai/station-sdk';

/** Aggregated stats shape returned by GET /scheduler/stats */
export interface SchedulerStatsResponse {
  providers: Record<string, SchedulerProviderStats>;
  summary: { totalJobs: number; totalRuns: number; successRate: number };
}

/** Aggregated status shape returned by GET /scheduler/status */
export interface SchedulerStatusResponse {
  providers: Record<
    string,
    SchedulerProviderStatus & { id: string; displayName: string }
  >;
}

/** Provider info returned by GET /scheduler/providers */
export interface SchedulerProviderInfo {
  id: string;
  displayName: string;
  capabilities: string[];
  formFields?: SchedulerFormField[];
}

export function getSchedulerEventInvalidationKeys(
  event: SchedulerEvent['event'],
): Array<readonly unknown[]> {
  switch (event) {
    case 'job.started':
    case 'job.missed':
    case 'job.deferred':
      return [['scheduler']];
    case 'job.completed':
    case 'job.failed':
    case 'job.retrying':
      return [['scheduler'], ['runs']];
    default:
      return [['scheduler']];
  }
}

function invalidateSchedulerEventQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  event: SchedulerEvent['event'],
) {
  for (const queryKey of getSchedulerEventInvalidationKeys(event)) {
    queryClient.invalidateQueries({ queryKey });
  }
}

export function isSchedulerDeferralTerminal(
  event: Pick<SchedulerEvent, 'disposition'>,
): boolean {
  return event.disposition !== 'waiting';
}

/** Subscribe to scheduler SSE events with exponential backoff reconnection. */
export function useSchedulerEvents(enabled = true) {
  const { apiBase } = useApiBase();
  const qc = useQueryClient();
  const { showToast } = useToast();
  const { navigate } = useNavigation();
  const runningRef = useRef(new Set<string>());
  const timeoutRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const recentErrorRef = useRef(new Set<string>());
  const missedRef = useRef(new Map<string, number>());
  useEffect(() => {
    if (!enabled) return;
    let authenticatedStream: FetchSseConnection | null = null;

    const clearRunTimeout = (job: string) => {
      const t = timeoutRef.current.get(job);
      if (t) {
        clearTimeout(t);
        timeoutRef.current.delete(job);
      }
    };

    authenticatedStream = fetchSSE(`${apiBase}/scheduler/events`, {
      authentication: 'required',
      retryDelayMs: 1000,
      maxRetryDelayMs: 30_000,
      maxRetries: 10,
      retryResetAfterMessages: 1,
      onMessage: (e) => {
        if (!e.data) return;
        try {
          const evt: SchedulerEvent = JSON.parse(e.data);
          if (evt.event === 'job.started') {
            runningRef.current.add(evt.job);
            clearRunTimeout(evt.job);
            timeoutRef.current.set(
              evt.job,
              setTimeout(() => {
                runningRef.current.delete(evt.job);
                timeoutRef.current.delete(evt.job);
                qc.invalidateQueries({ queryKey: ['scheduler'] });
              }, 5 * 60_000),
            );
            showToast(`Job '${evt.job}' started`);
            invalidateSchedulerEventQueries(qc, evt.event);
          } else if (evt.event === 'job.completed') {
            runningRef.current.delete(evt.job);
            missedRef.current.delete(evt.job);
            clearRunTimeout(evt.job);
            const dur = evt.duration_secs
              ? ` (${evt.duration_secs.toFixed(1)}s)`
              : '';
            showToast(`Job '${evt.job}' completed${dur}`, undefined, 8000, [
              {
                label: 'View Output',
                onClick: () =>
                  navigate('/schedule', {
                    job: evt.job,
                    run: evt.id || null,
                  }),
                variant: 'primary',
              },
            ]);
            invalidateSchedulerEventQueries(qc, evt.event);
          } else if (evt.event === 'job.failed') {
            runningRef.current.delete(evt.job);
            missedRef.current.delete(evt.job);
            clearRunTimeout(evt.job);
            if (!recentErrorRef.current.has(evt.job)) {
              showToast(
                `Job '${evt.job}' failed: ${evt.error || 'unknown error'}`,
                undefined,
                8000,
                [
                  {
                    label: 'View Output',
                    onClick: () =>
                      navigate('/schedule', {
                        job: evt.job,
                        run: evt.id || null,
                      }),
                    variant: 'secondary',
                  },
                ],
              );
            }
            recentErrorRef.current.delete(evt.job);
            invalidateSchedulerEventQueries(qc, evt.event);
          } else if (evt.event === 'job.retrying') {
            invalidateSchedulerEventQueries(qc, evt.event);
          } else if (evt.event === 'job.deferred') {
            if (isSchedulerDeferralTerminal(evt)) {
              runningRef.current.delete(evt.job);
              clearRunTimeout(evt.job);
            }
            invalidateSchedulerEventQueries(qc, evt.event);
          } else if (evt.event === 'job.missed') {
            missedRef.current.set(evt.job, evt.missedCount ?? 1);
            invalidateSchedulerEventQueries(qc, evt.event);
          }
        } catch {
          /* ignore parse errors */
        }
      },
    });

    return () => {
      authenticatedStream?.close();
      for (const t of timeoutRef.current.values()) clearTimeout(t);
      timeoutRef.current.clear();
    };
  }, [apiBase, qc, showToast, navigate, enabled]);

  const isRunning = useCallback(
    (jobName: string) => runningRef.current.has(jobName),
    [],
  );

  const getMissedCount = useCallback(
    (jobName: string) => missedRef.current.get(jobName) ?? 0,
    [],
  );

  const markErrorShown = useCallback((name: string) => {
    recentErrorRef.current.add(name);
    setTimeout(() => recentErrorRef.current.delete(name), 10_000);
  }, []);

  return { isRunning, runningJobs: runningRef, markErrorShown, getMissedCount };
}
