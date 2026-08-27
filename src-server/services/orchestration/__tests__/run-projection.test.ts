import { describe, expect, test } from 'vitest';
import {
  createScheduleRunId,
  parseScheduleRunId,
  projectSchedulerLogToRun,
} from '../run-projection.js';

describe('run projection', () => {
  test('projects scheduler logs into provider-qualified schedule runs', () => {
    const run = projectSchedulerLogToRun('plugin-a', {
      id: 'daily-1710000000',
      job: 'daily report',
      startedAt: '2026-04-25T12:00:00.000Z',
      completedAt: '2026-04-25T12:00:03.000Z',
      success: true,
      durationSecs: 3,
      manual: true,
      scheduledFor: '2026-04-25T12:00:00.000Z',
      firedAt: '2026-04-25T12:00:01.000Z',
      output: '/tmp/station/scheduler/logs/daily.log',
      attempt: 1,
      maxAttempts: 3,
    });

    expect(run).toMatchObject({
      runId: 'schedule:plugin-a:daily%20report:daily-1710000000',
      providerId: 'plugin-a',
      source: 'schedule',
      sourceId: 'daily report',
      status: 'completed',
      attempt: 1,
      maxAttempts: 3,
      outputRef: {
        source: 'schedule',
        providerId: 'plugin-a',
        kind: 'output',
        artifactId: 'daily-1710000000',
      },
      metadata: {
        manual: true,
        scheduledFor: '2026-04-25T12:00:00.000Z',
        firedAt: '2026-04-25T12:00:01.000Z',
        durationSecs: 3,
        legacyLogId: 'daily-1710000000',
      },
    });
  });

  test('keeps duplicate job and log ids distinct across providers', () => {
    const first = createScheduleRunId('provider-one', 'shared', 'run-1');
    const second = createScheduleRunId('provider-two', 'shared', 'run-1');

    expect(first).not.toBe(second);
    expect(parseScheduleRunId(first)).toEqual({
      providerId: 'provider-one',
      jobName: 'shared',
      logId: 'run-1',
    });
    expect(parseScheduleRunId(second)).toEqual({
      providerId: 'provider-two',
      jobName: 'shared',
      logId: 'run-1',
    });
  });

  test('failed scheduler logs expose conservative failure and retry state', () => {
    const run = projectSchedulerLogToRun('built-in', {
      id: 'run-2',
      job: 'nightly',
      startedAt: '2026-04-25T12:00:00.000Z',
      completedAt: '2026-04-25T12:00:03.000Z',
      success: false,
      error: 'agent failed',
      attempt: 1,
      maxAttempts: 2,
      state: 'failed',
    });

    expect(run.status).toBe('failed');
    expect(run.failureKind).toBe('agent_error');
    expect(run.failureMessage).toBe('agent failed');
    expect(run.retryEligible).toBe(true);
    expect(run.outputRef).toBeUndefined();
  });

  test('a failed run without a recorded reason says so rather than rendering a bare Failed', () => {
    // `SchedulerLogEntry.error` is optional while EVERY non-running
    // unsuccessful entry projects as `failed`, so the UI would otherwise show
    // a Failed pill with nothing beside it — indistinguishable from a broken
    // page. Naming the gap is a defect report about the writer, not a blank.
    const run = projectSchedulerLogToRun('built-in', {
      id: 'run-silent',
      job: 'nightly',
      startedAt: '2026-04-25T12:00:00.000Z',
      completedAt: '2026-04-25T12:00:03.000Z',
      success: false,
      state: 'failed',
    });

    expect(run.status).toBe('failed');
    expect(run.failureMessage).toBe('Failed without a recorded reason');
  });

  test('a failed run with captured output points at it instead of claiming no reason', () => {
    // `log.output` is the artifact PATH, so a pure projection cannot quote a
    // first line — but "without a recorded reason" beside an enabled Output
    // button would be false. Point at the artifact that does hold the reason.
    const run = projectSchedulerLogToRun('built-in', {
      id: 'run-output-only',
      job: 'nightly',
      startedAt: '2026-04-25T12:00:00.000Z',
      completedAt: '2026-04-25T12:00:03.000Z',
      success: false,
      output: '/tmp/station/scheduler/logs/run-output-only.log',
      state: 'failed',
    });

    expect(run.status).toBe('failed');
    expect(run.failureMessage).toBe('Failed — see output');
    expect(run.outputRef).toBeDefined();
  });

  test('a recorded reason still wins over the captured artifact', () => {
    expect(
      projectSchedulerLogToRun('built-in', {
        id: 'run-both',
        job: 'nightly',
        startedAt: '2026-04-25T12:00:00.000Z',
        completedAt: '2026-04-25T12:00:03.000Z',
        success: false,
        error: 'Engine never invoked: connection refused',
        output: '/tmp/station/scheduler/logs/run-both.log',
        state: 'failed',
      }).failureMessage,
    ).toBe('Engine never invoked: connection refused');
  });

  test('a running or successful run invents no failure message', () => {
    expect(
      projectSchedulerLogToRun('built-in', {
        id: 'run-live',
        job: 'nightly',
        startedAt: '2026-04-25T12:00:00.000Z',
        success: false,
        state: 'running',
      }).failureMessage,
    ).toBeUndefined();
    expect(
      projectSchedulerLogToRun('built-in', {
        id: 'run-ok',
        job: 'nightly',
        startedAt: '2026-04-25T12:00:00.000Z',
        completedAt: '2026-04-25T12:00:03.000Z',
        success: true,
        state: 'completed',
      }).failureMessage,
    ).toBeUndefined();
  });

  test('never calls a possible invocation retry-eligible', () => {
    const run = projectSchedulerLogToRun('built-in', {
      id: 'run-uncertain',
      job: 'nightly',
      startedAt: '2026-04-25T12:00:00.000Z',
      completedAt: '2026-04-25T12:00:03.000Z',
      success: false,
      error: 'provider connection ended',
      attempt: 1,
      maxAttempts: 3,
      state: 'indeterminate',
    });

    expect(run).toMatchObject({
      status: 'failed',
      failureKind: 'unknown',
      retryEligible: false,
      metadata: { schedulerState: 'indeterminate' },
    });
  });
});
