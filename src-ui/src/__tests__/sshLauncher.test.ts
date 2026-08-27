import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeTauri: vi.fn(),
}));

vi.mock('../platform/native/tauriInvoke', () => ({
  invokeTauri: mocks.invokeTauri,
}));

import { sshLauncher } from '../platform/native/sshLauncher';

describe('sshLauncher native Adapter', () => {
  afterEach(() => mocks.invokeTauri.mockReset());

  test('uses the reviewed lazy native command seam for every SSH launch operation', async () => {
    mocks.invokeTauri
      .mockResolvedValueOnce({
        nodeVersion: 'v24.0.0',
        nodeRequirement: '24.x',
      })
      .mockResolvedValueOnce('launch-1')
      .mockResolvedValueOnce({
        launchId: 'launch-1',
        phase: 'ready',
        reused: false,
        identityVerified: false,
        expectedSha: 'a'.repeat(40),
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    expect(mocks.invokeTauri).not.toHaveBeenCalled();
    await expect(sshLauncher.probe('dev@remote')).resolves.toEqual({
      nodeVersion: 'v24.0.0',
      nodeRequirement: '24.x',
    });
    await expect(
      sshLauncher.launch({
        target: 'dev@remote',
        sha: 'a'.repeat(40),
        localPort: 0,
        remotePort: 3141,
      }),
    ).resolves.toBe('launch-1');
    await expect(sshLauncher.status('launch-1')).resolves.toMatchObject({
      phase: 'ready',
    });
    await expect(sshLauncher.cancel('launch-1')).resolves.toBeUndefined();
    await expect(
      sshLauncher.markIdentityVerified('launch-1'),
    ).resolves.toBeUndefined();

    expect(mocks.invokeTauri).toHaveBeenNthCalledWith(1, 'ssh_env_probe', {
      target: 'dev@remote',
    });
    expect(mocks.invokeTauri).toHaveBeenNthCalledWith(2, 'ssh_launch_start', {
      request: {
        target: 'dev@remote',
        sha: 'a'.repeat(40),
        localPort: 0,
        remotePort: 3141,
      },
    });
    expect(mocks.invokeTauri).toHaveBeenNthCalledWith(3, 'ssh_launch_status', {
      launchId: 'launch-1',
    });
    expect(mocks.invokeTauri).toHaveBeenNthCalledWith(4, 'ssh_launch_cancel', {
      launchId: 'launch-1',
    });
    expect(mocks.invokeTauri).toHaveBeenNthCalledWith(
      5,
      'ssh_launch_mark_identity_verified',
      { launchId: 'launch-1' },
    );
  });

  test('keeps foreign native failures redacted at the launcher Interface', async () => {
    mocks.invokeTauri.mockRejectedValue(
      new Error('native command failed with token=super-secret-token'),
    );

    await expect(sshLauncher.probe('dev@remote')).rejects.toThrow(
      'native command failed with token=[REDACTED]',
    );
  });
});
