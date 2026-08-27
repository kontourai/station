/**
 * @vitest-environment jsdom
 */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../lib/device-settings-store';

const { show } = vi.hoisted(() => ({ show: vi.fn() }));
const { playDeliveredNotificationSound } = vi.hoisted(() => ({
  playDeliveredNotificationSound: vi.fn(),
}));

vi.mock('../contexts/ToastContext', () => ({
  toastStore: { show },
}));

vi.mock('../lib/notification-sounds', () => ({
  playDeliveredNotificationSound,
}));

import {
  handleNotificationDeliveredToast,
  NOTIFICATION_TOAST_DISPLAY_MS,
} from '../hooks/useServerEvents';

describe('handleNotificationDeliveredToast (station#1100 review fix, HIGH)', () => {
  beforeEach(() => {
    show.mockReset();
    playDeliveredNotificationSound.mockReset();
    const featureSettings = deviceSettingsStore.get('featureSettings');
    deviceSettingsStore.set('featureSettings', {
      ...featureSettings,
      notificationSounds: { ...DEFAULT_NOTIFICATION_SOUND_PREFERENCES },
    });
  });

  test('a job-failure delivery shows a toast bounded to the fixed display duration, not the 24h record TTL', () => {
    const featureSettings = deviceSettingsStore.get('featureSettings');
    deviceSettingsStore.set('featureSettings', {
      ...featureSettings,
      notificationSounds: {
        ...featureSettings.notificationSounds,
        'job-failure': 'bell',
      },
    });
    handleNotificationDeliveredToast({
      category: 'job-failure',
      title: 'Job "nightly-sync" failed',
      body: 'Something went wrong.',
      // The stored/pushed Notification.ttl for a job-failure is now 24h
      // (WAITING_TTL_MS) — this must NOT reach the toast as its duration.
      ttl: 24 * 60 * 60 * 1000,
      metadata: { link: '/schedule?job=nightly-sync' },
    });

    expect(show).toHaveBeenCalledTimes(1);
    const [message, sessionId, duration, actions, metadata] =
      show.mock.calls[0];
    expect(message).toBe('Job "nightly-sync" failed — Something went wrong.');
    expect(sessionId).toBeUndefined();
    expect(duration).toBe(NOTIFICATION_TOAST_DISPLAY_MS);
    expect(duration).toBeLessThan(60_000); // sanity: nowhere near 24h
    expect(actions).toBeUndefined();
    expect(metadata).toEqual({ link: '/schedule?job=nightly-sync' });
    expect(playDeliveredNotificationSound).toHaveBeenCalledWith(
      'job-failure',
      expect.objectContaining({ 'job-failure': 'bell' }),
    );
  });

  test('an approval-request delivery is still excluded (has its own dedicated UI)', () => {
    handleNotificationDeliveredToast({
      category: 'approval-request',
      title: 'Approval needed',
      body: 'An agent wants to use a tool.',
      ttl: 24 * 60 * 60 * 1000,
    });

    expect(show).not.toHaveBeenCalled();
  });

  test('a delivery with no title is a no-op (nothing to show)', () => {
    handleNotificationDeliveredToast({ category: 'job-failure', body: 'x' });
    expect(show).not.toHaveBeenCalled();
  });

  test('the fixed duration applies even when ttl is absent entirely', () => {
    handleNotificationDeliveredToast({
      category: 'general',
      title: 'Plain notice',
    });

    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][2]).toBe(NOTIFICATION_TOAST_DISPLAY_MS);
  });

  test('preserves navigateTo metadata for the notification card action', () => {
    const navigateTo = { project: 'research', layout: 'rss-reader' };

    handleNotificationDeliveredToast({
      category: 'rss-update',
      title: 'New article in Tech Feed',
      metadata: { navigateTo },
    });

    expect(show).toHaveBeenCalledWith(
      'New article in Tech Feed',
      undefined,
      NOTIFICATION_TOAST_DISPLAY_MS,
      undefined,
      { navigateTo },
    );
  });
});
