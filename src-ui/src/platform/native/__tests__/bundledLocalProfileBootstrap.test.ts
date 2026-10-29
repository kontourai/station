// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let bootstrapBundledLocalProfile: typeof import('../bundledLocalProfileBootstrap')['bootstrapBundledLocalProfile'];

describe('bundled local profile bootstrap', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ bootstrapBundledLocalProfile } = await import(
      '../bundledLocalProfileBootstrap'
    ));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Runs the bootstrap with its production timer (`window.setTimeout`) on a
   * virtual clock. `phaseAt` decides the owned sidecar's phase from elapsed
   * virtual milliseconds; `shownAt` decides whether the native host reports
   * this WebView as already shown (revealed main window, bypass, pop-out).
   */
  async function bootstrapOnVirtualClock(
    phaseAt: (elapsedMs: number) => string,
    runForMs: number,
    shownAt: (elapsedMs: number) => boolean = () => false,
  ) {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const getBundledServerStatus = vi.fn(async () => ({
      status: 'ok',
      value: { phase: phaseAt(Date.now() - startedAt), ownership: 'sidecar' },
    }));
    const isStartupWindowAdmitted = vi.fn(async () => ({
      status: 'ok',
      value: shownAt(Date.now() - startedAt),
    }));
    const invoke = vi.fn(async (command: string) =>
      command === 'station_ensure_bundled_local_profile' ? 'local' : undefined,
    );
    const repository = {
      refresh: vi.fn(async () => true),
      selectProfileForProcess: vi.fn(() => 'station-profile:local'),
      pendingLocalSelfProvisionProfileName: vi.fn(() => undefined),
      authorizeActiveConnection: vi.fn(async () => true),
    };
    let settled = false;
    const result = bootstrapBundledLocalProfile({
      adapter: { getBundledServerStatus, isStartupWindowAdmitted } as never,
      repository: repository as never,
      invoke,
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(runForMs);
    return {
      result,
      settled: () => settled,
      getBundledServerStatus,
      isStartupWindowAdmitted,
      invoke,
      repository,
    };
  }

  function expectNothingAuthored(run: {
    invoke: ReturnType<typeof vi.fn>;
    repository: Record<string, ReturnType<typeof vi.fn>>;
  }) {
    expect(run.invoke).not.toHaveBeenCalled();
    expect(run.repository.refresh).not.toHaveBeenCalled();
    expect(run.repository.authorizeActiveConnection).not.toHaveBeenCalled();
  }

  function expectAuthoredInPlace(run: {
    invoke: ReturnType<typeof vi.fn>;
    repository: Record<string, ReturnType<typeof vi.fn>>;
  }) {
    expect(run.invoke).toHaveBeenCalledWith(
      'station_ensure_bundled_local_profile',
    );
    expect(run.repository.authorizeActiveConnection).toHaveBeenCalledWith(
      'station-profile:local',
    );
  }

  test('keeps waiting for an owned sidecar whose cold boot outlasts a minute, then authors and authorizes its profile', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) => (elapsed < 90_000 ? 'starting' : 'running'),
      95_000,
    );
    expect(run.settled()).toBe(true);
    await expect(run.result).resolves.toEqual({});
    expectAuthoredInPlace(run);
    // After the first minute the wait backs off instead of polling at 10 Hz.
    expect(run.getBundledServerStatus.mock.calls.length).toBeLessThan(700);
  });

  test('behind the startup cover a failed sidecar is waited for, and a Restart that reaches running authors in place', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) =>
        elapsed < 40_000
          ? 'failed'
          : elapsed < 100_000
            ? 'starting'
            : 'running',
      99_000,
      () => false,
    );
    expect(run.settled()).toBe(false);
    expectNothingAuthored(run);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run.settled()).toBe(true);
    await expect(run.result).resolves.toEqual({});
    expectAuthoredInPlace(run);
  });

  test.each(['failed', 'stopped'])(
    'a window already shown to the user releases the loader at once when the owned sidecar is %s, and stops polling',
    async (phase) => {
      const run = await bootstrapOnVirtualClock(
        () => phase,
        0,
        () => true,
      );
      expect(run.settled()).toBe(true);
      await expect(run.result).resolves.toEqual({});
      await vi.advanceTimersByTimeAsync(300_000);
      expect(run.getBundledServerStatus).toHaveBeenCalledTimes(1);
      expectNothingAuthored(run);
    },
  );

  test('a covered window that is revealed while the sidecar is failed releases at its next observation', async () => {
    const run = await bootstrapOnVirtualClock(
      () => 'failed',
      30_000,
      (elapsed) => elapsed >= 20_000,
    );
    expect(run.settled()).toBe(true);
    expectNothingAuthored(run);
  });

  test('stopping always respawns, so it is waited for even in a shown window', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) =>
        elapsed < 5_000 ? 'stopping' : elapsed < 8_000 ? 'starting' : 'running',
      4_000,
      () => true,
    );
    expect(run.settled()).toBe(false);
    expect(run.isStartupWindowAdmitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run.settled()).toBe(true);
    expectAuthoredInPlace(run);
  });

  test('a shown window waits on a progressing sidecar for the bounded budget, then releases to the recovery UI', async () => {
    const run = await bootstrapOnVirtualClock(
      () => 'starting',
      55_000,
      () => true,
    );
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.settled()).toBe(true);
    await expect(run.result).resolves.toEqual({});
    const pollsAtRelease = run.getBundledServerStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run.getBundledServerStatus).toHaveBeenCalledTimes(pollsAtRelease);
    expectNothingAuthored(run);
  });

  test('past the budget a covered window re-checks admission on every poll, so a later reveal releases it', async () => {
    const run = await bootstrapOnVirtualClock(
      () => 'starting',
      70_000,
      (elapsed) => elapsed >= 75_000,
    );
    expect(run.settled()).toBe(false);
    const checksBefore = run.isStartupWindowAdmitted.mock.calls.length;
    expect(checksBefore).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(run.settled()).toBe(true);
    expectNothingAuthored(run);
  });

  test('a covered window has no wall-clock limit on a progressing sidecar', async () => {
    const run = await bootstrapOnVirtualClock(
      () => 'restarting',
      600_000,
      () => false,
    );
    expect(run.settled()).toBe(false);
    expect(run.isStartupWindowAdmitted).toHaveBeenCalled();
    expectNothingAuthored(run);
  });

  test('a failed admission read releases at once instead of waiting', async () => {
    vi.useFakeTimers();
    const getBundledServerStatus = vi.fn(async () => ({
      status: 'ok',
      value: { phase: 'failed', ownership: 'sidecar' },
    }));
    let settled = false;
    const result = bootstrapBundledLocalProfile({
      adapter: {
        getBundledServerStatus,
        isStartupWindowAdmitted: vi.fn(async () => ({
          status: 'error',
          command: 'startup-window-admitted',
          message: 'bridge unavailable',
        })),
      } as never,
      repository: {} as never,
      invoke: vi.fn(),
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await expect(result).resolves.toEqual({});
    expect(getBundledServerStatus).toHaveBeenCalledTimes(1);
  });

  test('an adapter without native readiness releases rather than hang a visible window', async () => {
    vi.useFakeTimers();
    const getBundledServerStatus = vi.fn(async () => ({
      status: 'ok',
      value: { phase: 'failed', ownership: 'sidecar' },
    }));
    const result = await bootstrapBundledLocalProfile({
      adapter: {
        getBundledServerStatus,
        isStartupWindowAdmitted: vi.fn(async () => ({
          status: 'unsupported',
          command: 'startup-window-admitted',
          reason: 'no native readiness',
        })),
      } as never,
      repository: {} as never,
      invoke: vi.fn(),
    });
    expect(result).toEqual({});
    expect(getBundledServerStatus).toHaveBeenCalledTimes(1);
  });

  test('restarting is waited for, then a covered window keeps waiting once the supervisor reports failed', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) => (elapsed < 20_000 ? 'restarting' : 'failed'),
      60_000,
    );
    expect(run.settled()).toBe(false);
    expect(run.isStartupWindowAdmitted).toHaveBeenCalled();
    expectNothingAuthored(run);
  });

  test('does not author a profile while the owned sidecar is not running', async () => {
    const run = await bootstrapOnVirtualClock(() => 'restarting', 180_000);
    expect(run.settled()).toBe(false);
    expect(run.invoke).not.toHaveBeenCalled();
  });

  test('waits for the owned sidecar, asks native code to author the profile, provisions, and authorizes it', async () => {
    const getBundledServerStatus = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'ok',
        value: { phase: 'starting', ownership: 'sidecar' },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        value: { phase: 'running', ownership: 'sidecar' },
      });
    const invoke = vi.fn(async (command: string) =>
      command === 'station_ensure_bundled_local_profile' ? 'local' : undefined,
    );
    const repository = {
      refresh: vi.fn(async () => true),
      selectProfileForProcess: vi.fn(() => 'station-profile:local'),
      pendingLocalSelfProvisionProfileName: vi.fn(() => 'local'),
      authorizeActiveConnection: vi.fn(async () => true),
    };

    await expect(
      bootstrapBundledLocalProfile({
        adapter: { getBundledServerStatus } as never,
        repository: repository as never,
        invoke,
        wait: vi.fn(async () => undefined),
      }),
    ).resolves.toEqual({});
    expect(invoke).toHaveBeenCalledWith('station_ensure_bundled_local_profile');
    expect(invoke).toHaveBeenCalledWith('station_local_self_provision', {
      profileName: 'local',
    });
    expect(repository.refresh).toHaveBeenCalledTimes(2);
    expect(repository.authorizeActiveConnection).toHaveBeenCalledWith(
      'station-profile:local',
    );
  });

  test('selects and authorizes a stopped attached service without provisioning or changing the shared default', async () => {
    const wait = vi.fn(async () => undefined);
    const adapter = {
      getBundledServerStatus: vi.fn(async () => ({
        status: 'ok',
        value: { phase: 'stopped', ownership: 'service' },
      })),
    };
    const repository = {
      refresh: vi.fn(async () => true),
      selectProfileForProcess: vi.fn(() => 'station-profile:beta-local'),
      pendingLocalSelfProvisionProfileName: vi.fn(() => 'beta-local'),
      authorizeActiveConnection: vi.fn(async () => true),
    };
    const invoke = vi.fn(async () => 'beta-local');
    await expect(
      bootstrapBundledLocalProfile({
        adapter: adapter as never,
        repository: repository as never,
        invoke,
        wait,
      }),
    ).resolves.toEqual({});
    expect(wait).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      'station_local_self_provision',
      expect.anything(),
    );
    expect(repository.authorizeActiveConnection).toHaveBeenCalledWith(
      'station-profile:beta-local',
    );
  });

  test('keeps an explicit process selection over the channel-owned sidecar without provisioning another profile', async () => {
    const repository = {
      refresh: vi.fn(async () => true),
      // The repository resolves this to a user-selected remote Station rather
      // than the automatic beta-local candidate returned by native ownership.
      selectProfileForProcess: vi.fn(() => 'station-profile:chosen-remote'),
      pendingLocalSelfProvisionProfileName: vi.fn(() => undefined),
      authorizeActiveConnection: vi.fn(async () => true),
    };
    const invoke = vi.fn(async (command: string) =>
      command === 'station_ensure_bundled_local_profile'
        ? 'beta-local'
        : undefined,
    );

    await expect(
      bootstrapBundledLocalProfile({
        adapter: {
          getBundledServerStatus: vi.fn(async () => ({
            status: 'ok',
            value: { phase: 'running', ownership: 'sidecar' },
          })),
        } as never,
        repository: repository as never,
        invoke,
      }),
    ).resolves.toEqual({});

    expect(repository.selectProfileForProcess).toHaveBeenCalledWith(
      'beta-local',
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'station_local_self_provision',
      expect.anything(),
    );
    expect(repository.authorizeActiveConnection).toHaveBeenCalledWith(
      'station-profile:chosen-remote',
    );
  });

  test('fails closed for a confirmed unowned channel home without authorizing the shared default', async () => {
    const repository = {
      refresh: vi.fn(),
      selectProfileForProcess: vi.fn(),
      pendingLocalSelfProvisionProfileName: vi.fn(),
      authorizeActiveConnection: vi.fn(),
      authorizeDefaultProfile: vi.fn(async () => true),
    };
    await expect(
      bootstrapBundledLocalProfile({
        adapter: {
          getBundledServerStatus: vi.fn(async () => ({
            status: 'ok',
            value: { phase: 'stopped', ownership: 'none' },
          })),
        } as never,
        repository: repository as never,
        invoke: vi.fn(async () => null),
      }),
    ).resolves.toEqual({});
    expect(repository.selectProfileForProcess).not.toHaveBeenCalled();
    expect(repository.authorizeDefaultProfile).not.toHaveBeenCalled();
    expect(repository.authorizeActiveConnection).not.toHaveBeenCalled();
  });

  test('does not fall back to the shared default when owner resolution fails', async () => {
    await expect(
      bootstrapBundledLocalProfile({
        adapter: {
          getBundledServerStatus: vi.fn(async () => ({
            status: 'ok',
            value: { phase: 'stopped', ownership: 'service' },
          })),
        } as never,
        repository: {} as never,
        invoke: vi.fn(async () => {
          throw new Error('ambiguous owner');
        }),
      }),
    ).resolves.toEqual({});
  });

  test('surfaces a replacement keyring write failure instead of collapsing it into connect failure', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'station_ensure_bundled_local_profile') return 'local';
      if (command === 'station_local_self_provision') {
        throw {
          code: 'credential_replacement_write_failed',
          message: 'write denied',
        };
      }
      return undefined;
    });
    const repository = {
      refresh: vi.fn(async () => true),
      selectProfileForProcess: vi.fn(() => 'station-profile:local'),
      pendingLocalSelfProvisionProfileName: vi.fn(() => 'local'),
      authorizeActiveConnection: vi.fn(async () => true),
    };

    await expect(
      bootstrapBundledLocalProfile({
        adapter: {
          getBundledServerStatus: vi.fn(async () => ({
            status: 'ok',
            value: { phase: 'running', ownership: 'sidecar' },
          })),
        } as never,
        repository: repository as never,
        invoke,
      }),
    ).resolves.toEqual({
      recoveryError:
        'Station recovered access but could not save the replacement credential. Unlock your keychain or credential store, then relaunch Station.',
    });
    expect(repository.authorizeActiveConnection).not.toHaveBeenCalled();
  });
});
