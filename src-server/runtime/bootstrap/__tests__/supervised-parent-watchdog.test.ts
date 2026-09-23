import { describe, expect, test, vi } from 'vitest';
import {
  armSupervisedParentWatchdog,
  SUPERVISED_PARENT_WATCHDOG_GRACE_MS,
  SUPERVISED_PARENT_WATCHDOG_INTERVAL_MS,
  shouldStopForMissingSupervisor,
} from '../supervised-parent-watchdog.js';

/** The watchdog's tick starts an async probe; let it settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('supervised parent watchdog', () => {
  test('does not arm for an unmanaged plain station start', async () => {
    const setInterval = vi.fn();
    armSupervisedParentWatchdog({
      env: {},
      logger: { error: vi.fn() },
      onSupervisorGone: vi.fn(),
      setInterval: setInterval as never,
    });

    await expect(shouldStopForMissingSupervisor(undefined, 1)).resolves.toBe(
      false,
    );
    expect(setInterval).not.toHaveBeenCalled();
  });

  test('uses injected parent PID and clock to gracefully stop an orphaned supervised server', async () => {
    let check: (() => void) | undefined;
    let forceExit: (() => void) | undefined;
    const logger = { error: vi.fn() };
    const onSupervisorGone = vi.fn();
    const exit = vi.fn();
    armSupervisedParentWatchdog({
      env: { STATION_SUPERVISOR_PID: '123' },
      exit,
      getParentPid: () => 1,
      logger,
      now: () => Date.UTC(2026, 7, 8),
      onSupervisorGone,
      setInterval: (callback, delayMs) => {
        expect(delayMs).toBe(SUPERVISED_PARENT_WATCHDOG_INTERVAL_MS);
        check = callback;
        return { unref: vi.fn() } as never;
      },
      setTimeout: (callback, delayMs) => {
        expect(delayMs).toBe(SUPERVISED_PARENT_WATCHDOG_GRACE_MS);
        forceExit = callback;
        return { unref: vi.fn() } as never;
      },
    });

    check?.();
    await settle();
    expect(onSupervisorGone).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Supervised parent watchdog detected a missing supervisor',
      expect.objectContaining({
        observedAt: '2026-08-08T00:00:00.000Z',
        parentPid: 1,
        supervisorPid: '123',
      }),
    );
    forceExit?.();
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('keeps a server alive while its supervised parent PID still matches', async () => {
    let check: (() => void) | undefined;
    const onSupervisorGone = vi.fn();
    armSupervisedParentWatchdog({
      env: { STATION_SUPERVISOR_PID: '123' },
      getParentPid: () => 123,
      logger: { error: vi.fn() },
      onSupervisorGone,
      setInterval: (callback) => {
        check = callback;
        return { unref: vi.fn() } as never;
      },
    });

    check?.();
    await settle();
    await expect(shouldStopForMissingSupervisor('123', 123)).resolves.toBe(
      false,
    );
    expect(onSupervisorGone).not.toHaveBeenCalled();
  });

  test('uses the captured birth fingerprint even when Windows retains the parent PID', async () => {
    await expect(
      shouldStopForMissingSupervisor('123', 123, 'birth-a', async () => 'birth-b'),
    ).resolves.toBe(true);
    await expect(
      shouldStopForMissingSupervisor('123', 123, 'birth-a', async () => 'birth-a'),
    ).resolves.toBe(false);
  });

  // #2327: `ps -o lstart=` timing out on a loaded host returned null, which
  // read as "supervisor gone" and shut down a live desktop's server while
  // ppid still named the supervisor.
  test('a failed identity probe is not proof the supervisor is gone', async () => {
    const failedProbe = async () => null;
    await expect(
      shouldStopForMissingSupervisor('123', 123, 'birth-a', failedProbe, 'darwin'),
    ).resolves.toBe(false);
    await expect(
      shouldStopForMissingSupervisor('123', 123, 'birth-a', failedProbe, 'win32'),
    ).resolves.toBe(false);
    const throwingProbe = async () => {
      throw new Error('probe crashed');
    };
    await expect(
      shouldStopForMissingSupervisor('123', 123, 'birth-a', throwingProbe, 'darwin'),
    ).resolves.toBe(false);
  });

  test('a failed identity probe still falls back to the Unix ppid backstop', async () => {
    await expect(
      shouldStopForMissingSupervisor('123', 1, 'birth-a', async () => null, 'darwin'),
    ).resolves.toBe(true);
  });

  test('a live supervisor survives an armed watchdog whose probe fails', async () => {
    let check: (() => void) | undefined;
    const onSupervisorGone = vi.fn();
    armSupervisedParentWatchdog({
      env: { STATION_SUPERVISOR_PID: '123', STATION_SUPERVISOR_BIRTH: 'birth-a' },
      getParentPid: () => 123,
      lookupSupervisorBirth: async () => null,
      logger: { error: vi.fn() },
      onSupervisorGone,
      setInterval: (callback) => {
        check = callback;
        return { unref: vi.fn() } as never;
      },
    });

    check?.();
    await settle();
    expect(onSupervisorGone).not.toHaveBeenCalled();
  });

  test('skips a tick while the previous probe is still in flight', async () => {
    let check: (() => void) | undefined;
    let resolveProbe: ((birth: string | null) => void) | undefined;
    const lookupSupervisorBirth = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const onSupervisorGone = vi.fn();
    armSupervisedParentWatchdog({
      env: { STATION_SUPERVISOR_PID: '123', STATION_SUPERVISOR_BIRTH: 'birth-a' },
      getParentPid: () => 123,
      lookupSupervisorBirth,
      logger: { error: vi.fn() },
      onSupervisorGone,
      setInterval: (callback) => {
        check = callback;
        return { unref: vi.fn() } as never;
      },
      setTimeout: () => ({ unref: vi.fn() }) as never,
    });

    check?.();
    check?.();
    expect(lookupSupervisorBirth).toHaveBeenCalledTimes(1);
    resolveProbe?.('birth-b');
    await settle();
    expect(onSupervisorGone).toHaveBeenCalledTimes(1);
  });
});
