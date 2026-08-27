import type { AgentRunSummary } from '@kontourai/station-contracts/orchestration';
import type {
  RunOutputRef,
  RunSummary,
} from '@kontourai/station-contracts/runs';
import type { SchedulerLogEntry } from '@kontourai/station-contracts/scheduler';

function encodeRunPart(value: string): string {
  return encodeURIComponent(value);
}

function decodeRunPart(value: string): string {
  return decodeURIComponent(value);
}

export function createScheduleRunId(
  providerId: string,
  jobName: string,
  logId: string,
): string {
  return `schedule:${encodeRunPart(providerId)}:${encodeRunPart(jobName)}:${encodeRunPart(logId)}`;
}

export function parseScheduleRunId(
  runId: string,
): { providerId: string; jobName: string; logId: string } | null {
  const [source, providerId, jobName, logId, ...rest] = runId.split(':');
  if (source !== 'schedule' || !providerId || !jobName || !logId || rest.length)
    return null;
  return {
    providerId: decodeRunPart(providerId),
    jobName: decodeRunPart(jobName),
    logId: decodeRunPart(logId),
  };
}

export function createOrchestrationRunId(
  providerId: string,
  sessionId: string,
): string {
  return `orchestration:${encodeRunPart(providerId)}:${encodeRunPart(sessionId)}`;
}

export function projectOrchestrationRun(run: AgentRunSummary): RunSummary {
  const runId = createOrchestrationRunId(run.providerId, run.sessionId);
  return {
    runId,
    providerId: run.providerId,
    source: 'orchestration',
    sourceId: run.sessionId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    failureKind: run.failureKind,
    failureMessage: run.failureMessage,
    retryEligible: run.retryEligible,
    attempt: run.attempt,
    metadata: {
      legacyRunId: run.runId,
      sessionId: run.sessionId,
      engineExecution: run.engineExecution,
      cwd: run.cwd,
      runtimeThreadId: run.runtimeThreadId,
      eventCount: run.eventCount,
    },
  };
}

/**
 * What a failed run row says when its writer recorded no `error`.
 *
 * Every non-running unsuccessful log projects as `failed`, so the UI renders a
 * Failed pill whether or not there is a reason. A bare pill tells a reader
 * nothing and looks like a bug in the page, so the blank is named rather than
 * left empty — except when there IS somewhere to look. `log.output` is a
 * captured-output PATH, not its content (`receipt.settle({ output: outFile })`),
 * so this projection cannot quote a first line without reading the file, and a
 * pure projection does not do I/O. Pointing at the artifact is the true
 * statement it can make; "without a recorded reason" beside an enabled Output
 * button would be false.
 */
function schedulerFailureMessage(log: SchedulerLogEntry): string {
  if (log.error) return log.error;
  return log.output
    ? 'Failed — see output'
    : 'Failed without a recorded reason';
}

export function projectSchedulerLogToRun(
  providerId: string,
  log: SchedulerLogEntry,
): RunSummary {
  const runId = createScheduleRunId(providerId, log.job, log.id);
  const outputRef: RunOutputRef | undefined = log.output
    ? {
        source: 'schedule',
        providerId,
        runId,
        artifactId: log.id,
        kind: 'output',
      }
    : undefined;

  return {
    runId,
    providerId,
    source: 'schedule',
    sourceId: log.job,
    status:
      log.state === 'running'
        ? 'running'
        : log.success
          ? 'completed'
          : 'failed',
    startedAt: log.startedAt,
    updatedAt: log.completedAt ?? log.startedAt,
    completedAt: log.completedAt,
    failureKind:
      log.state === 'running' || log.success
        ? undefined
        : log.state === 'indeterminate'
          ? 'unknown'
          : 'agent_error',
    failureMessage:
      log.state === 'running' || log.success
        ? log.error
        : schedulerFailureMessage(log),
    retryEligible:
      log.state === 'failed' &&
      !log.success &&
      (log.attempt ?? 1) < (log.maxAttempts ?? log.attempt ?? 1),
    attempt: log.attempt ?? 1,
    maxAttempts: log.maxAttempts,
    outputRef,
    metadata: {
      job: log.job,
      jobId: log.jobId,
      scheduledFor: log.scheduledFor,
      firedAt: log.firedAt,
      manual: log.manual ?? false,
      missedCount: log.missedCount,
      durationSecs: log.durationSecs,
      legacyLogId: log.id,
      ...(log.state ? { schedulerState: log.state } : {}),
    },
  };
}
