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
    // `toEqual` against the whole literal is deliberate HERE and is not the
    // hazard the case below describes: `{ status: 'no-update' }` is the entire
    // declared variant, with no optional members, so this freezes a shape the
    // type already closes rather than asserting the absence of a documented
    // field. If that variant ever grows one, a failure here is the right
    // prompt to decide whether "no update" may carry anything at all.
    await expect(checkForDesktopUpdate()).resolves.toEqual({
      status: 'no-update',
    });
  });

  it('reports a quiet check-failed outcome when the plugin call rejects', async () => {
    // Covers both a build with no updater plugin registered at all (dev, or
    // a channel whose endpoint has not shipped) and a real network/signature
    // failure — indistinguishable from here, and both must land here.
    check.mockRejectedValue(new Error('no such plugin'));
    // Not `toEqual` against a whole object literal. The outcome type declares
    // an OPTIONAL `detail`, so a literal that omits it asserts that field's
    // ABSENCE — which is not what this case is about, and is why #2032 adding
    // the field (deliberately, documented) reddened a test that had no
    // interest in it and held Nightly red from 2026-09-12.
    //
    // What this case IS about: a rejected plugin call becomes a quiet
    // non-throwing outcome rather than an exception or an update prompt. The
    // `await` below is the "does not throw" half — a rejection fails the test
    // here rather than being caught.
    const outcome = await checkForDesktopUpdate();
    if (outcome.status !== 'check-failed')
      throw new Error(`expected check-failed, got ${outcome.status}`);
    // Quiet means nothing to act on: no version to offer, no install to press.
    expect(outcome).not.toHaveProperty('version');
    expect(outcome).not.toHaveProperty('install');
    // `detail` IS pinned, and verbatim: `DesktopUpdateCheck.tsx` renders it
    // straight into the technical-details disclosure, and the module's own
    // docblock promises the caught message UNCLASSIFIED because it cannot tell
    // a missing update channel from an offline host or a bad signature.
    // Replacing it with a sentence of this module's own would break that
    // promise silently, so the assertion is the thrown message exactly.
    expect(outcome.detail).toBe('no such plugin');
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
