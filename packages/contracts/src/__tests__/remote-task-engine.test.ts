import { describe, expect, test } from 'vitest';
import {
  engineLimitProblems,
  engineLimitsOf,
  managedRemoteTaskVendorAllowed,
} from '../managed-policy-engines.js';
import {
  nextRemoteTaskPollDelay,
  REMOTE_TASK_ACKNOWLEDGEMENT_VERSION,
  REMOTE_TASK_RETRY_AFTER_CEILING_MS,
  REMOTE_TASK_VENDOR_IDS,
  REMOTE_TASK_VENDOR_LABELS,
  remoteTaskAcknowledgementCovers,
  remoteTaskAcknowledgementStatement,
  remoteTaskPollingProblems,
} from '../remote-task-engine.js';

const POLLING = { intervalMs: 10_000, maxBackoffMs: 60_000 };

describe('remote task polling bounds', () => {
  test('accepts in-range values', () => {
    expect(remoteTaskPollingProblems(POLLING)).toEqual([]);
    expect(
      remoteTaskPollingProblems({ intervalMs: 5_000, maxBackoffMs: 1_800_000 }),
    ).toEqual([]);
  });

  test.each([
    [{ intervalMs: 4_999, maxBackoffMs: 60_000 }, 'intervalMs'],
    [{ intervalMs: 600_001, maxBackoffMs: 1_800_000 }, 'intervalMs'],
    [{ intervalMs: 10_000, maxBackoffMs: 1_800_001 }, 'maxBackoffMs'],
    [{ intervalMs: 10_000.5, maxBackoffMs: 60_000 }, 'intervalMs'],
    [{ intervalMs: 60_000, maxBackoffMs: 10_000 }, 'not be less'],
    [{ intervalMs: 10_000 }, 'maxBackoffMs'],
    [{ intervalMs: 10_000, maxBackoffMs: 60_000, jitter: 1 }, 'jitter'],
    ['15s', 'object'],
  ])('refuses %j', (value, fragment) => {
    const problems = remoteTaskPollingProblems(value);
    expect(problems.join('\n')).toContain(fragment);
  });
});

describe('nextRemoteTaskPollDelay', () => {
  test('success polls after the interval', () => {
    expect(nextRemoteTaskPollDelay(POLLING, 40_000, { kind: 'ok' })).toBe(
      10_000,
    );
  });
  test('failure doubles up to the ceiling', () => {
    expect(nextRemoteTaskPollDelay(POLLING, 0, { kind: 'failed' })).toBe(
      20_000,
    );
    expect(nextRemoteTaskPollDelay(POLLING, 40_000, { kind: 'failed' })).toBe(
      60_000,
    );
  });
  test("a rate limit honors the vendor's wait, up to the hard ceiling", () => {
    expect(
      nextRemoteTaskPollDelay(POLLING, 10_000, {
        kind: 'rate-limited',
        retryAfterMs: 5_000,
      }),
    ).toBe(20_000);
    expect(
      nextRemoteTaskPollDelay(POLLING, 10_000, {
        kind: 'rate-limited',
        retryAfterMs: 120_000,
      }),
    ).toBe(120_000);
    expect(
      nextRemoteTaskPollDelay(POLLING, 10_000, {
        kind: 'rate-limited',
        retryAfterMs: 10 * REMOTE_TASK_RETRY_AFTER_CEILING_MS,
      }),
    ).toBe(REMOTE_TASK_RETRY_AFTER_CEILING_MS);
  });
});

describe('remote task acknowledgement', () => {
  test.each(REMOTE_TASK_VENDOR_IDS)(
    'the %s statement names the vendor and says code leaves the computer',
    (vendor) => {
      const statement = remoteTaskAcknowledgementStatement(vendor);
      expect(statement).toContain(REMOTE_TASK_VENDOR_LABELS[vendor]);
      expect(statement).toContain('leave this computer');
    },
  );

  test('covers only the same vendor, version and exact statement', () => {
    const ack = {
      vendor: 'devin' as const,
      version: REMOTE_TASK_ACKNOWLEDGEMENT_VERSION,
      statement: remoteTaskAcknowledgementStatement('devin'),
      acknowledgedAt: '2026-11-14T00:00:00.000Z',
    };
    expect(remoteTaskAcknowledgementCovers(ack, 'devin')).toBe(true);
    expect(remoteTaskAcknowledgementCovers(ack, 'cursor')).toBe(false);
    expect(
      remoteTaskAcknowledgementCovers({ ...ack, version: 0 }, 'devin'),
    ).toBe(false);
    expect(
      remoteTaskAcknowledgementCovers(
        { ...ack, statement: `${ack.statement}.` },
        'devin',
      ),
    ).toBe(false);
    expect(remoteTaskAcknowledgementCovers(null, 'devin')).toBe(false);
  });
});

describe('limits.engines.remoteTasks', () => {
  test('accepts known vendors and copies them', () => {
    const limits = { engines: { remoteTasks: ['devin', 'cursor'] } };
    expect(engineLimitProblems(limits)).toEqual([]);
    expect(engineLimitsOf(limits).engines?.remoteTasks).toEqual([
      'devin',
      'cursor',
    ]);
  });

  test('refuses unknown and repeated vendors and a non-list', () => {
    expect(
      engineLimitProblems({
        engines: { remoteTasks: ['factory', 'devin', 'devin'] },
      }),
    ).toEqual([
      {
        path: 'limits.engines.remoteTasks[0]',
        message: 'must be one of devin, github-copilot, cursor',
      },
      {
        path: 'limits.engines.remoteTasks[2]',
        message: 'repeats an earlier vendor',
      },
    ]);
    expect(engineLimitProblems({ engines: { remoteTasks: 'devin' } })).toEqual([
      {
        path: 'limits.engines.remoteTasks',
        message: 'must be an array of remote task vendor ids',
      },
    ]);
  });

  test('without a policy every vendor is allowed; with one only those listed', () => {
    expect(managedRemoteTaskVendorAllowed(null, 'devin')).toBe(true);
    expect(managedRemoteTaskVendorAllowed({}, 'devin')).toBe(false);
    expect(managedRemoteTaskVendorAllowed({ engines: {} }, 'devin')).toBe(
      false,
    );
    expect(
      managedRemoteTaskVendorAllowed(
        { engines: { remoteTasks: ['devin'] } },
        'devin',
      ),
    ).toBe(true);
    expect(
      managedRemoteTaskVendorAllowed(
        { engines: { remoteTasks: ['devin'] } },
        'cursor',
      ),
    ).toBe(false);
  });
});
