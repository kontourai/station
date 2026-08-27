import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runSelfUpdateWatchdog } from '../self-update-watchdog.js';

const PARAMS = {
  pid: 4242,
  port: 3141,
  hash: 'abc1234',
  instanceId: 'default',
  startedAt: '2026-08-02T03:28:43.483Z',
};

function healthyResponse(
  overrides: { shortSha?: string; instanceId?: string } = {},
) {
  return {
    status: 200,
    json: () =>
      Promise.resolve({
        build: {
          shortSha: overrides.shortSha ?? PARAMS.hash,
          instanceId: overrides.instanceId ?? PARAMS.instanceId,
        },
      }),
  };
}

function processIdentityDeps(
  alive: () => boolean = () => true,
  lookup: () => string | null = () => 'child-start',
) {
  return {
    alive: () => (alive() ? ('alive' as const) : ('dead' as const)),
    lookup,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runSelfUpdateWatchdog — the real incident: bound port, never answered (AC: critical)', () => {
  test('does not run a watchdog or fabricate a terminal record for a nonpositive pid', async () => {
    const fetchImpl = vi.fn();
    const writeRecord = vi.fn();

    await expect(
      runSelfUpdateWatchdog({ ...PARAMS, pid: 0 }, { fetchImpl, writeRecord }),
    ).rejects.toThrow('positive server pid');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(writeRecord).not.toHaveBeenCalled();
  });

  test('a child that binds the port but never answers is detected, killed, and recorded failed', async () => {
    // Every fetch attempt hangs forever, exactly like a socket that accepted
    // the connection and then never wrote a response — the wedge this
    // watchdog exists to catch (station#1903). It must never resolve on its
    // own; only the watchdog's own per-attempt timeout should move things
    // forward.
    const fetchImpl = vi.fn(
      (_url: string, _signal: AbortSignal) =>
        new Promise<{ status: number; json: () => Promise<unknown> }>(() => {}),
    );
    const killProcess = vi.fn();
    const alive = vi.fn(() => true); // still holding the port throughout
    const writeRecord = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 10_000,
        pollIntervalMs: 1_000,
        requestTimeoutMs: 1_000,
        killGraceMs: 2_000,
      },
      {
        fetchImpl,
        killProcess,
        processIdentityDeps: processIdentityDeps(alive),
        writeRecord,
        logger,
      },
    );

    await vi.advanceTimersByTimeAsync(20_000);
    const record = await run;

    // Never treated a hung request as healthy.
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url] of fetchImpl.mock.calls) {
      expect(url).toBe('http://127.0.0.1:3141/api/system/status');
    }

    // Killed: SIGTERM first, then SIGKILL once the grace period elapsed
    // with the process still alive.
    expect(killProcess).toHaveBeenNthCalledWith(1, 4242, 'SIGTERM');
    expect(killProcess).toHaveBeenNthCalledWith(2, 4242, 'SIGKILL');

    // Recorded failed durably with a bounded safe code.
    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        hash: 'abc1234',
        pid: 4242,
        failureCode: 'health-unreachable',
      }),
    );
    expect(record.status).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; SIGTERM and SIGKILL were sent after verified identity, and the watched child was still alive when the watchdog stopped looking',
      expect.objectContaining({ terminationObserved: 'alive' }),
    );
  });

  test("a child that exits outright (not tonight's bug, but must also fail) is recorded failed without a spurious kill", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const killProcess = vi.fn();
    const alive = vi.fn(() => false); // already gone
    const writeRecord = vi.fn();

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 5_000,
        pollIntervalMs: 1_000,
        requestTimeoutMs: 500,
      },
      {
        fetchImpl,
        killProcess,
        processIdentityDeps: processIdentityDeps(alive),
        writeRecord,
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const record = await run;

    expect(killProcess).not.toHaveBeenCalled(); // nothing alive to signal
    expect(record.status).toBe('failed');
    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  test('keeps the original committed failed verdict when warning and error sinks throw', async () => {
    const writeRecord = vi.fn(() => ({
      committed: true as const,
      durability: 'uncertain' as const,
      warning: 'directory fsync interrupted',
    }));
    const logger = {
      warn: vi.fn(() => {
        throw new Error('warn sink failed');
      }),
      error: vi.fn(() => {
        throw new Error('error sink failed');
      }),
      info: vi.fn(),
    };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 5_000,
        pollIntervalMs: 1_000,
        requestTimeoutMs: 500,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        processIdentityDeps: processIdentityDeps(() => false),
        writeRecord,
        logger,
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(run).resolves.toMatchObject({ status: 'failed' });
    expect(writeRecord).toHaveBeenCalledTimes(1);
  });
});

describe('runSelfUpdateWatchdog — identity, not just liveness (AC: review finding 1)', () => {
  test('a 200 reporting the WRONG sha never verifies, is killed, and records only the fixed identity-mismatch code', async () => {
    // Models the class #1903 names: the new build (hash Y) crashed on boot
    // and freed the port, and something else — an auto-respawned OLD build,
    // in this case — answers 200 on it throughout the whole budget.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        healthyResponse({
          shortSha: 'oldbuild',
          instanceId: PARAMS.instanceId,
        }),
      ),
    );
    const killProcess = vi.fn();
    const alive = vi.fn(() => true);
    const writeRecord = vi.fn();

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 5_000,
        pollIntervalMs: 1_000,
        requestTimeoutMs: 500,
        killGraceMs: 500,
      },
      {
        fetchImpl,
        killProcess,
        processIdentityDeps: processIdentityDeps(alive),
        writeRecord,
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const record = await run;

    expect(fetchImpl).toHaveBeenCalled(); // it WAS reachable — that's the point
    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(record.status).toBe('failed');
    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureCode: 'identity-mismatch',
      }),
    );
    expect(writeRecord.mock.calls.length).toBeGreaterThan(0);
    const [firstCallArgs] = writeRecord.mock.calls;
    expect(firstCallArgs[0]).not.toHaveProperty('detail');
  });

  test('does not persist credential URLs, paths, or tokens from an observed mismatched identity', async () => {
    const secrets = [
      'https://user:password@example.test/private',
      '/Users/alice/.station/private-build',
      'token=station-secret-token',
    ];
    const writeRecord = vi.fn();
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 300,
        killGraceMs: 300,
      },
      {
        fetchImpl: vi.fn(() =>
          Promise.resolve(
            healthyResponse({
              shortSha: secrets[0],
              instanceId: `${secrets[1]} ${secrets[2]}`,
            }),
          ),
        ),
        processIdentityDeps: processIdentityDeps(() => false),
        writeRecord,
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(run).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'identity-mismatch',
    });

    const persisted = JSON.stringify(writeRecord.mock.calls);
    for (const secret of secrets) expect(persisted).not.toContain(secret);
  });

  test('a 200 reporting the WRONG instanceId never verifies', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        healthyResponse({
          shortSha: PARAMS.hash,
          instanceId: 'other-instance',
        }),
      ),
    );
    const killProcess = vi.fn();
    const writeRecord = vi.fn();

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 3_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 300,
        killGraceMs: 300,
      },
      {
        fetchImpl,
        killProcess,
        processIdentityDeps: processIdentityDeps(() => false),
        writeRecord,
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const record = await run;

    expect(record.status).toBe('failed');
  });

  test('a 200 with no build field at all (older/unrelated server) never verifies', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({}) }),
    );
    const writeRecord = vi.fn();

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 300,
        killGraceMs: 300,
      },
      {
        fetchImpl,
        processIdentityDeps: processIdentityDeps(() => false),
        writeRecord,
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const record = await run;

    expect(record.status).toBe('failed');
  });
});

describe('runSelfUpdateWatchdog — healthy new server', () => {
  test.each(['warn', 'info'] as const)(
    'keeps a committed verified verdict when the %s diagnostic sink throws',
    async (level) => {
      const writeRecord = vi.fn(() => ({
        committed: true as const,
        durability: 'uncertain' as const,
        warning: 'directory fsync interrupted',
      }));
      const logger = {
        warn: vi.fn(() => {
          if (level === 'warn') throw new Error('warn sink failed');
        }),
        info: vi.fn(() => {
          if (level === 'info') throw new Error('info sink failed');
        }),
        error: vi.fn(),
      };

      const record = await runSelfUpdateWatchdog(
        { ...PARAMS, deadlineMs: 10_000, pollIntervalMs: 1_000 },
        {
          fetchImpl: vi.fn(() => Promise.resolve(healthyResponse())),
          writeRecord,
          logger,
        },
      );

      expect(record.status).toBe('verified');
      expect(writeRecord).toHaveBeenCalledTimes(1);
    },
  );

  test('a 200 with the matching identity within budget is recorded verified and nothing is killed', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(healthyResponse()));
    const killProcess = vi.fn();
    const writeRecord = vi.fn();

    const record = await runSelfUpdateWatchdog(
      { ...PARAMS, deadlineMs: 10_000, pollIntervalMs: 1_000 },
      { fetchImpl, killProcess, writeRecord },
    );

    expect(killProcess).not.toHaveBeenCalled();
    expect(record.status).toBe('verified');
    expect(record.resolvedAt).toBeTruthy();
    expect(writeRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'verified', hash: 'abc1234' }),
    );
  });

  test('keeps polling through early non-200 responses, wrong-identity responses, and connection refusals, then verifies', async () => {
    let call = 0;
    const fetchImpl = vi.fn(() => {
      call += 1;
      if (call === 1)
        return Promise.resolve({
          status: 500,
          json: () => Promise.resolve({}),
        });
      if (call === 2) return Promise.reject(new Error('ECONNREFUSED'));
      if (call === 3)
        return Promise.resolve(healthyResponse({ shortSha: 'stalebld' }));
      return Promise.resolve(healthyResponse());
    });
    const writeRecord = vi.fn();
    const killProcess = vi.fn();

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 30_000,
        pollIntervalMs: 1_000,
        requestTimeoutMs: 500,
      },
      { fetchImpl, killProcess, writeRecord },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const record = await run;

    expect(call).toBeGreaterThanOrEqual(4);
    expect(killProcess).not.toHaveBeenCalled();
    expect(record.status).toBe('verified');
  });
});

describe('runSelfUpdateWatchdog — kill sequence', () => {
  test('captures the child birth at registration and never signals a recycled pid', async () => {
    const lookup = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('original-start')
      .mockReturnValue('recycled-start');
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const killProcess = vi.fn();
    const writeRecord = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
      },
      {
        fetchImpl,
        killProcess,
        processIdentityDeps: processIdentityDeps(() => true, lookup),
        writeRecord,
        logger,
      },
    );

    // Registration takes the fingerprint before the first asynchronous health
    // attempt. A lazy lookup at termination would capture `recycled-start`.
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    const record = await run;

    expect(killProcess, 'a recycled pid was signalled').not.toHaveBeenCalled();
    expect(record.status).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; watched child identity no longer matched or could not be verified, so no signal was sent',
      expect.objectContaining({ pid: 4242 }),
    );
  });

  test('registration finds a dead child, signals nothing, and reports it already gone', async () => {
    const killProcess = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        killProcess,
        processIdentityDeps: processIdentityDeps(() => false),
        writeRecord: vi.fn(),
        logger,
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(killProcess, 'dead pid was signalled').not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; watched child was already gone before the watchdog sent a signal',
      expect.objectContaining({ pid: 4242 }),
    );
  });

  test('falls back to liveness when registration cannot fingerprint the child and confirms it exited after SIGTERM', async () => {
    const lookup = vi.fn<() => string | null>(() => null);
    const killProcess = vi.fn();
    let alive = true;
    killProcess.mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') alive = false;
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
        killGraceMs: 500,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        killProcess,
        processIdentityDeps: processIdentityDeps(() => alive, lookup),
        writeRecord: vi.fn(),
        logger,
      },
    );

    expect(
      lookup,
      'a pid was signalled without any identity capture at registration (lazy capture)',
    ).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(
      killProcess,
      'a live pid without a registration fingerprint was not signalled',
    ).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; watched child was observed gone after signalling without identity verification because this host could not fingerprint the process',
      expect.objectContaining({ pid: 4242, terminationObserved: 'gone' }),
    );
  });

  test('fails closed when exact identity becomes unavailable before a signal', async () => {
    const lookup = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('child-start')
      .mockReturnValue(null);
    const killProcess = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        killProcess,
        processIdentityDeps: processIdentityDeps(() => true, lookup),
        writeRecord: vi.fn(),
        logger,
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(
      killProcess,
      'pid with a verified registration identity was signalled after identity became unavailable',
    ).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; watched child identity no longer matched or could not be verified, so no signal was sent',
      expect.objectContaining({ terminationObserved: 'unknown' }),
    );
  });

  test('rechecks identity before SIGKILL, not just before SIGTERM', async () => {
    const lookup = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('child-start')
      .mockReturnValueOnce('child-start')
      .mockReturnValue('recycled-start');
    const killProcess = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
        killGraceMs: 500,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        killProcess,
        processIdentityDeps: processIdentityDeps(() => true, lookup),
        writeRecord: vi.fn(),
        logger,
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(
      killProcess,
      'a second signal went out after the pid was recycled between SIGTERM and SIGKILL',
    ).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; SIGTERM was sent after verified identity, SIGKILL was skipped because watched child identity no longer matched or could not be verified, and the watched child state could not be confirmed when the watchdog stopped looking',
      expect.objectContaining({ terminationObserved: 'unknown' }),
    );
  });

  test('reports an unavailable identity after SIGTERM as an unconfirmed escalation skip', async () => {
    const lookup = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('child-start')
      .mockReturnValueOnce('child-start')
      .mockReturnValue(null);
    const killProcess = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
        killGraceMs: 500,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        killProcess,
        processIdentityDeps: processIdentityDeps(() => true, lookup),
        writeRecord: vi.fn(),
        logger,
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; SIGTERM was sent after verified identity, SIGKILL was skipped because watched child identity no longer matched or could not be verified, and the watched child state could not be confirmed when the watchdog stopped looking',
      expect.objectContaining({ terminationObserved: 'unknown' }),
    );
  });

  test('reports a failed SIGKILL delivery as still alive, not terminated', async () => {
    const killProcess = vi.fn((_pid, signal) => {
      if (signal === 'SIGKILL') throw new Error('EPERM');
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
        killGraceMs: 500,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        killProcess,
        processIdentityDeps: processIdentityDeps(),
        writeRecord: vi.fn(),
        logger,
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(killProcess).toHaveBeenNthCalledWith(1, 4242, 'SIGTERM');
    expect(killProcess).toHaveBeenNthCalledWith(2, 4242, 'SIGKILL');
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; SIGTERM was sent after verified identity, SIGKILL could not be delivered, and the watched child was still alive when the watchdog stopped looking',
      expect.objectContaining({ terminationObserved: 'alive' }),
    );
  });

  test('checks whether a child is gone when SIGTERM cannot be delivered', async () => {
    let alive = true;
    const killProcess = vi.fn(() => {
      alive = false;
      throw new Error('ESRCH');
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
      },
      {
        fetchImpl: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
        killProcess,
        processIdentityDeps: processIdentityDeps(() => alive),
        writeRecord: vi.fn(),
        logger,
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(killProcess).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
    expect(logger.error).toHaveBeenCalledWith(
      'Self-update watchdog: new server failed health verification; SIGTERM could not be delivered and the watched child was observed gone before the watchdog stopped looking',
      expect.objectContaining({ terminationObserved: 'gone' }),
    );
  });

  test('does not escalate to SIGKILL when the process exits after SIGTERM within the grace period', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const killProcess = vi.fn();
    let alive = true;
    const childAlive = vi.fn(() => alive);
    killProcess.mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') alive = false; // graceful shutdown
    });
    const writeRecord = vi.fn();

    const run = runSelfUpdateWatchdog(
      {
        ...PARAMS,
        deadlineMs: 2_000,
        pollIntervalMs: 500,
        requestTimeoutMs: 200,
        killGraceMs: 5_000,
      },
      {
        fetchImpl,
        killProcess,
        processIdentityDeps: processIdentityDeps(childAlive),
        writeRecord,
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
  });
});
