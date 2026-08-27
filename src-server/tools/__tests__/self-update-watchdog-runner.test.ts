import { describe, expect, test, vi } from 'vitest';
import type {
  RestartStateWriteResult,
  SelfUpdateRestartRecord,
} from '../../routes/system/self-update-restart-state.js';
import { runWatchdogEntrypoint } from '../self-update-watchdog-runner.js';

const VALID_INPUT = {
  pid: 4242,
  port: 3141,
  hash: 'abc1234',
  instanceId: 'default',
  startedAt: '2026-08-02T03:28:43.483Z',
  gitRoot: '/repo',
};

function argv(json?: string): string[] {
  return [
    'node',
    'self-update-watchdog.js',
    ...(json !== undefined ? [json] : []),
  ];
}

describe('runWatchdogEntrypoint — malformed input (AC: never crash silently)', () => {
  test('unparseable JSON is logged and returns exit 1 without attempting a write', async () => {
    const writeRecord = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const code = await runWatchdogEntrypoint(argv('{not json'), {
      writeRecord,
      logger,
    });
    expect(code).toBe(1);
    expect(logger.error).toHaveBeenCalled();
    // Nothing to identify a record by — writing one would fabricate an
    // instanceId/hash/pid that was never actually provided.
    expect(writeRecord).not.toHaveBeenCalled();
  });

  test('JSON missing required fields is refused the same way', async () => {
    const writeRecord = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const code = await runWatchdogEntrypoint(
      argv(JSON.stringify({ pid: 4242 })),
      { writeRecord, logger },
    );
    expect(code).toBe(1);
    expect(writeRecord).not.toHaveBeenCalled();
  });

  test('no argument at all is refused', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const code = await runWatchdogEntrypoint(argv(undefined), {
      writeRecord: vi.fn(),
      logger,
    });
    expect(code).toBe(1);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('runWatchdogEntrypoint — internal crash after valid input (AC: review finding 2)', () => {
  test('keeps a verified watchdog verdict successful when publication committed but directory durability is uncertain', async () => {
    const verified: SelfUpdateRestartRecord = {
      instanceId: 'default',
      hash: 'abc1234',
      pid: 4242,
      port: 3141,
      startedAt: '2026-08-02T03:28:43.483Z',
      status: 'verified',
      resolvedAt: '2026-08-02T03:29:00.000Z',
    };
    const committedUncertain: RestartStateWriteResult = {
      committed: true,
      durability: 'uncertain',
      warning: 'parent directory fsync failed',
    };
    const writeRecord = vi.fn(() => committedUncertain);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const code = await runWatchdogEntrypoint(
      argv(JSON.stringify(VALID_INPUT)),
      {
        runWatchdog: vi.fn(async (_params, deps) => {
          deps.writeRecord(verified);
          return verified;
        }),
        writeRecord,
        logger,
      },
    );

    expect(code).toBe(0);
    expect(writeRecord).toHaveBeenCalledWith(
      '/repo/.station/self-update-restart.json',
      verified,
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('the verification logic throwing is caught, recorded with a fixed crash code, and returns exit 1', async () => {
    // Models the realistic production failure the reviewer named: something
    // inside the watchdog's own run throws unexpectedly (a disk error, a
    // bug) rather than the parent's spawn call itself throwing. A corrupt or
    // missing entry FILE failing at module-load time — before ANY of this
    // code runs — cannot be exercised through a function call; that class is
    // instead covered by self-update-boot-report.test.ts's stale-pending
    // path, since a watchdog that never starts leaves the parent's `pending`
    // record to age past the budget.
    const runWatchdog = vi
      .fn()
      .mockRejectedValue(new Error('EACCES: disk write failed'));
    const writeRecord = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const code = await runWatchdogEntrypoint(
      argv(JSON.stringify(VALID_INPUT)),
      {
        runWatchdog,
        writeRecord,
        logger,
      },
    );

    expect(code).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'self-update-watchdog: crashed before a terminal verdict',
      undefined,
    );
    expect(writeRecord).toHaveBeenCalledWith(
      '/repo/.station/self-update-restart.json',
      expect.objectContaining({
        instanceId: 'default',
        hash: 'abc1234',
        pid: 4242,
        port: 3141,
        status: 'failed',
        failureCode: 'watchdog-crashed',
      }),
    );
  });

  test('a crash where even the best-effort failure write throws is still caught and still returns exit 1', async () => {
    const runWatchdog = vi.fn().mockRejectedValue(new Error('boom'));
    const writeRecord = vi.fn(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const code = await runWatchdogEntrypoint(
      argv(JSON.stringify(VALID_INPUT)),
      {
        runWatchdog,
        writeRecord,
        logger,
      },
    );

    expect(code).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'self-update-watchdog: also failed to record the crash',
      undefined,
    );
  });

  test('emits a fixed best-effort warning for a committed-but-uncertain crash verdict without leaking the crash text', async () => {
    const secret = 'https://user:secret@example.test/private';
    const writeRecord = vi.fn(() => ({
      committed: true as const,
      durability: 'uncertain' as const,
      warning: 'directory fsync interrupted',
    }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('warn sink failed');
      }),
      error: vi.fn(() => {
        throw new Error('error sink failed');
      }),
    };

    const code = await runWatchdogEntrypoint(
      argv(JSON.stringify(VALID_INPUT)),
      {
        runWatchdog: vi.fn().mockRejectedValue(new Error(secret)),
        writeRecord,
        logger,
      },
    );

    expect(code).toBe(1);
    expect(writeRecord).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'self-update-watchdog: crash verdict committed with uncertain directory durability',
      undefined,
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });

  test('never serializes Error text or coerces hostile foreign throws into a crash record', async () => {
    const secrets = [
      'https://user:password@example.test/private',
      '/Users/alice/.station/secret-file',
      'token=station-secret-token',
    ];
    const hostile = {
      toString: () => {
        throw new Error('foreign toString must not run');
      },
      valueOf: () => {
        throw new Error('foreign valueOf must not run');
      },
    };

    for (const thrown of [new Error(secrets.join(' ')), hostile]) {
      const writeRecord = vi.fn();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await expect(
        runWatchdogEntrypoint(argv(JSON.stringify(VALID_INPUT)), {
          runWatchdog: vi.fn().mockRejectedValue(thrown),
          writeRecord,
          logger,
        }),
      ).resolves.toBe(1);

      const persisted = JSON.stringify(writeRecord.mock.calls);
      for (const secret of secrets) expect(persisted).not.toContain(secret);
      expect(persisted).toContain('watchdog-crashed');
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secrets[0]);
    }
  });
});

describe('runWatchdogEntrypoint — normal outcomes', () => {
  test('a verified record exits 0', async () => {
    const runWatchdog = vi.fn().mockResolvedValue({
      status: 'verified',
    } satisfies Partial<SelfUpdateRestartRecord> as SelfUpdateRestartRecord);
    const code = await runWatchdogEntrypoint(
      argv(JSON.stringify(VALID_INPUT)),
      {
        runWatchdog,
        writeRecord: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    );
    expect(code).toBe(0);
  });

  test('a failed record exits 1', async () => {
    const runWatchdog = vi.fn().mockResolvedValue({
      status: 'failed',
    } satisfies Partial<SelfUpdateRestartRecord> as SelfUpdateRestartRecord);
    const code = await runWatchdogEntrypoint(
      argv(JSON.stringify(VALID_INPUT)),
      {
        runWatchdog,
        writeRecord: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
    );
    expect(code).toBe(1);
  });

  test('the runWatchdog call receives the parsed identity and gitRoot-derived state path', async () => {
    const runWatchdog = vi.fn().mockResolvedValue({
      status: 'verified',
    } satisfies Partial<SelfUpdateRestartRecord> as SelfUpdateRestartRecord);
    const writeRecord = vi.fn();
    await runWatchdogEntrypoint(argv(JSON.stringify(VALID_INPUT)), {
      runWatchdog,
      writeRecord,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(runWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 4242,
        port: 3141,
        hash: 'abc1234',
        instanceId: 'default',
        startedAt: VALID_INPUT.startedAt,
      }),
      expect.objectContaining({
        writeRecord: expect.any(Function),
        logger: expect.anything(),
      }),
    );
  });
});
