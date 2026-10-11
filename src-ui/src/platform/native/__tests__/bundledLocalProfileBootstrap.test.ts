// @vitest-environment jsdom
import { resetLocalSelfProvisionLatchForTests } from '@kontourai/station-connect/local-self-provision';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { bootstrapBundledLocalProfile } from '../bundledLocalProfileBootstrap';

describe('bundled local profile bootstrap', () => {
  beforeEach(() => {
    resetLocalSelfProvisionLatchForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Runs the bootstrap with its production timer (`window.setTimeout`) on a
   * virtual clock. `phaseAt` decides the owned sidecar's phase from elapsed
   * virtual milliseconds, standing in for a slow cold boot. `statusFails`
   * makes a status read reject at that elapsed time.
   */
  async function bootstrapOnVirtualClock(
    phaseAt: (elapsedMs: number) => string,
    runForMs: number,
    statusFails: (elapsedMs: number) => boolean = () => false,
  ) {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const getBundledServerStatus = vi.fn(async () => {
      const elapsed = Date.now() - startedAt;
      if (statusFails(elapsed)) throw new Error('status bridge unavailable');
      return {
        status: 'ok',
        value: { phase: phaseAt(elapsed), ownership: 'sidecar' },
      };
    });
    const invoke = vi.fn(async (command: string) =>
      command === 'station_ensure_bundled_local_profile' ? 'local' : undefined,
    );
    const repository = {
      refresh: vi.fn(async () => true),
      selectProfileForProcess: vi.fn(() => 'station-profile:local'),
      pendingLocalSelfProvisionProfileName: vi.fn(() => undefined),
      authorizeActiveConnection: vi.fn(async () => true),
    };
    const reload = vi.fn(() => undefined);
    let settled = false;
    const result = bootstrapBundledLocalProfile({
      adapter: { getBundledServerStatus } as never,
      repository: repository as never,
      invoke,
      reload,
    }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(runForMs);
    return {
      result,
      settled: () => settled,
      getBundledServerStatus,
      invoke,
      repository,
      reload,
    };
  }

  /** The background wait may only reload; it never authors or authorizes. */
  function expectNoBackgroundAuthoring(run: {
    invoke: ReturnType<typeof vi.fn>;
    repository: Record<string, ReturnType<typeof vi.fn>>;
  }) {
    expect(run.invoke).not.toHaveBeenCalled();
    expect(run.repository.refresh).not.toHaveBeenCalled();
    expect(run.repository.authorizeActiveConnection).not.toHaveBeenCalled();
  }

  test('keeps waiting for an owned sidecar whose cold boot outlasts a minute, then authors and authorizes its profile', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) => (elapsed < 90_000 ? 'starting' : 'running'),
      95_000,
    );
    expect(run.settled()).toBe(true);
    await expect(run.result).resolves.toEqual({});
    expect(run.invoke).toHaveBeenCalledWith(
      'station_ensure_bundled_local_profile',
    );
    expect(run.repository.authorizeActiveConnection).toHaveBeenCalledWith(
      'station-profile:local',
    );
    expect(run.reload).not.toHaveBeenCalled();
    // After the first minute the wait backs off instead of polling at 10 Hz.
    expect(run.getBundledServerStatus.mock.calls.length).toBeLessThan(700);
  });

  test.each(['failed', 'stopped', 'stopping'])(
    'a reload while the owned sidecar is %s releases the loader to the recovery UI at once',
    async (phase) => {
      const run = await bootstrapOnVirtualClock(() => phase, 0);
      expect(run.settled()).toBe(true);
      await expect(run.result).resolves.toEqual({});
      // A sidecar that never recovers is watched quietly: no reload, and the
      // background never authors a profile or blocks the shell.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(run.reload).not.toHaveBeenCalled();
      expectNoBackgroundAuthoring(run);
    },
  );

  test('an explicit Restart after a failed owned sidecar reloads once so first paint re-runs the bootstrap', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) =>
        elapsed < 40_000
          ? 'failed'
          : elapsed < 100_000
            ? 'starting'
            : 'running',
      0,
    );
    expect(run.settled()).toBe(true);
    await vi.advanceTimersByTimeAsync(99_000);
    expect(run.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.reload).toHaveBeenCalledTimes(1);
    expectNoBackgroundAuthoring(run);
  });

  test('a crash right after the handshake (running then restarting) still reloads exactly once and authors nothing in the background', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) =>
        elapsed < 10_000
          ? 'failed'
          : elapsed < 11_000
            ? 'running'
            : elapsed < 20_000
              ? 'restarting'
              : 'running',
      60_000,
    );
    expect(run.settled()).toBe(true);
    expect(run.reload).toHaveBeenCalledTimes(1);
    expectNoBackgroundAuthoring(run);
  });

  test('status-bridge failures while waiting in the background are not unhandled rejections', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) => (elapsed < 30_000 ? 'failed' : 'running'),
      40_000,
      (elapsed) => elapsed > 1_000 && elapsed < 20_000,
    );
    expect(run.settled()).toBe(true);
    expect(run.reload).toHaveBeenCalledTimes(1);
    expectNoBackgroundAuthoring(run);
  });

  test('restarting is waited for and settles to the recovery UI once the supervisor reports failed', async () => {
    const run = await bootstrapOnVirtualClock(
      (elapsed) => (elapsed < 20_000 ? 'restarting' : 'failed'),
      19_000,
    );
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.settled()).toBe(true);
    await expect(run.result).resolves.toEqual({});
    expectNoBackgroundAuthoring(run);
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
