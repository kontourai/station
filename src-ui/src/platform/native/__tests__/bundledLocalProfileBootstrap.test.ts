import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resetLocalSelfProvisionLatchForTests } from '../../../../../packages/connect/src/core/localSelfProvision';

import { bootstrapBundledLocalProfile } from '../bundledLocalProfileBootstrap';

describe('bundled local profile bootstrap', () => {
  beforeEach(() => {
    resetLocalSelfProvisionLatchForTests();
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
