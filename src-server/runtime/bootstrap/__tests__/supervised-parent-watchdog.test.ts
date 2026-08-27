import { describe, expect, test, vi } from 'vitest';
import {
  armSupervisedParentWatchdog,
  SUPERVISED_PARENT_WATCHDOG_GRACE_MS,
  SUPERVISED_PARENT_WATCHDOG_INTERVAL_MS,
  shouldStopForMissingSupervisor,
} from '../supervised-parent-watchdog.js';

describe('supervised parent watchdog', () => {
  test('does not arm for an unmanaged plain station start', () => {
    const setInterval = vi.fn();
    armSupervisedParentWatchdog({
      env: {},
      logger: { error: vi.fn() },
      onSupervisorGone: vi.fn(),
      setInterval: setInterval as never,
    });

    expect(shouldStopForMissingSupervisor(undefined, 1)).toBe(false);
    expect(setInterval).not.toHaveBeenCalled();
  });

  test('uses injected parent PID and clock to gracefully stop an orphaned supervised server', () => {
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

  test('keeps a server alive while its supervised parent PID still matches', () => {
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
    expect(shouldStopForMissingSupervisor('123', 123)).toBe(false);
    expect(onSupervisorGone).not.toHaveBeenCalled();
  });

  test('uses the captured birth fingerprint even when Windows retains the parent PID', () => {
    expect(
      shouldStopForMissingSupervisor('123', 123, 'birth-a', () => 'birth-b'),
    ).toBe(true);
    expect(
      shouldStopForMissingSupervisor('123', 123, 'birth-a', () => 'birth-a'),
    ).toBe(false);
  });
});
