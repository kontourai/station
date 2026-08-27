import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Station's notification delivery is web push, which needs `PushManager` —
 * absent in Android WebView — so the native app silently never subscribes and
 * cannot be told anything. On a live Station the same phone reports
 * `push=yes` in a browser and `push=no` in the app.
 *
 * This is a *local* notification from the running app. It reaches a
 * backgrounded Station; it cannot wake a closed one, which needs FCM/APNs.
 */

const sendNotification = vi.fn();
const requestPermission = vi.fn();
const isPermissionGranted = vi.fn();

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: (...args: unknown[]) => sendNotification(...args),
  requestPermission: () => requestPermission(),
  isPermissionGranted: () => isPermissionGranted(),
}));

import { createNativeNotifier } from '../platform/native/notifier';

beforeEach(() => {
  sendNotification.mockReset();
  requestPermission.mockReset();
  isPermissionGranted.mockReset();
});

describe('native notifier', () => {
  it('posts once permission is granted', async () => {
    isPermissionGranted.mockResolvedValue(true);
    const notifier = createNativeNotifier();
    await notifier.ensurePermission();
    await notifier.notify({ title: 'A device is asking to pair' });
    expect(sendNotification).toHaveBeenCalledWith({
      title: 'A device is asking to pair',
      body: undefined,
    });
  });

  it('asks once, not on every delivery', async () => {
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue('granted');
    const notifier = createNativeNotifier();
    await notifier.ensurePermission();
    await notifier.ensurePermission();
    await notifier.ensurePermission();
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('stays silent when permission was refused', async () => {
    isPermissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue('denied');
    const notifier = createNativeNotifier();
    await notifier.ensurePermission();
    await notifier.notify({ title: 'ignored' });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('never posts before permission has been established', async () => {
    // Posting here would prompt as a side effect of an incoming notification —
    // a dialog raised because a stranger's device asked to pair, which nudges
    // the user to tap through whatever is behind it.
    isPermissionGranted.mockResolvedValue(true);
    const notifier = createNativeNotifier();
    await notifier.notify({ title: 'too early' });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('reports unavailable when the host has no plugin', async () => {
    isPermissionGranted.mockRejectedValue(new Error('no such plugin'));
    const notifier = createNativeNotifier();
    await expect(notifier.isAvailable()).resolves.toBe(false);
  });

  it('treats a failed permission check as refused rather than throwing', async () => {
    isPermissionGranted.mockRejectedValue(new Error('unavailable'));
    const notifier = createNativeNotifier();
    await expect(notifier.ensurePermission()).resolves.toBe(false);
  });

  it('swallows a failed post so in-app delivery is undisturbed', async () => {
    // The toast has already been shown by the time this runs; an OS failure
    // must not become a user-visible error.
    isPermissionGranted.mockResolvedValue(true);
    sendNotification.mockImplementation(() => {
      throw new Error('OS refused');
    });
    const notifier = createNativeNotifier();
    await notifier.ensurePermission();
    await expect(notifier.notify({ title: 'x' })).resolves.toBeUndefined();
  });
});
