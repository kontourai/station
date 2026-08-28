import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Desktop shell self-update (station#575). The Rust side registers the
 * updater plugin only when the build carries a usable `plugins.updater`
 * config, so every other build has no plugin at all and `check()` rejects.
 * That rejection and a genuine offline/signature failure are
 * indistinguishable from here — both must resolve the same quiet outcome.
 */

const check = vi.fn();
const downloadAndInstall = vi.fn();
const relaunch = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => check(...args),
}));
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));

import { checkForDesktopUpdate } from '../platform/native/desktopUpdate';

beforeEach(() => {
  check.mockReset();
  downloadAndInstall.mockReset();
  relaunch.mockReset();
});

describe('checkForDesktopUpdate', () => {
  it('reports an available update with an install action', async () => {
    check.mockResolvedValue({
      version: '2026.8.28',
      downloadAndInstall,
    });
    const outcome = await checkForDesktopUpdate();
    expect(outcome).toMatchObject({
      status: 'update-available',
      version: '2026.8.28',
    });
  });

  it('reports no update when the plugin resolves null', async () => {
    check.mockResolvedValue(null);
    await expect(checkForDesktopUpdate()).resolves.toEqual({
      status: 'no-update',
    });
  });

  it('reports a quiet check-failed outcome when the plugin call rejects', async () => {
    // Covers both a build with no updater plugin registered at all (dev, or
    // a channel whose endpoint has not shipped) and a real network/signature
    // failure — indistinguishable from here, and both must land here.
    check.mockRejectedValue(new Error('no such plugin'));
    await expect(checkForDesktopUpdate()).resolves.toEqual({
      status: 'check-failed',
    });
  });

  it('installs by calling downloadAndInstall then relaunch, in order', async () => {
    const calls: string[] = [];
    downloadAndInstall.mockImplementation(async () => {
      calls.push('downloadAndInstall');
    });
    relaunch.mockImplementation(async () => {
      calls.push('relaunch');
    });
    check.mockResolvedValue({ version: '2026.8.28', downloadAndInstall });

    const outcome = await checkForDesktopUpdate();
    if (outcome.status !== 'update-available')
      throw new Error('expected update-available');
    await outcome.install();

    expect(calls).toEqual(['downloadAndInstall', 'relaunch']);
  });

  it('propagates a failed install rather than swallowing it', async () => {
    downloadAndInstall.mockRejectedValue(new Error('signature check failed'));
    check.mockResolvedValue({ version: '2026.8.28', downloadAndInstall });

    const outcome = await checkForDesktopUpdate();
    if (outcome.status !== 'update-available')
      throw new Error('expected update-available');
    await expect(outcome.install()).rejects.toThrow('signature check failed');
    expect(relaunch).not.toHaveBeenCalled();
  });
});
