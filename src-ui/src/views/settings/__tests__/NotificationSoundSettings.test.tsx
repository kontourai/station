/** @vitest-environment jsdom */

import {
  DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
  type FeatureSettings,
} from '@kontourai/station-contracts/device-settings';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { update, previewNotificationSound, playDeliveredNotificationSound } =
  vi.hoisted(() => ({
    update: vi.fn(),
    previewNotificationSound: vi.fn(),
    playDeliveredNotificationSound: vi.fn(),
  }));
const settings: FeatureSettings = {
  ttsReadbackEnabled: false,
  pushNotificationsEnabled: false,
  voiceS2SEnabled: false,
  mobilePairingEnabled: false,
  notificationSounds: { ...DEFAULT_NOTIFICATION_SOUND_PREFERENCES },
};

vi.mock('../../../hooks/useFeatureSettings', () => ({
  useFeatureSettings: () => ({ settings, update }),
}));

// The delivery function is the foreground notification seam. The settings
// component imports only the local preview function; keeping both exports in
// this mock proves a select change cannot deliver a real notification.
vi.mock('../../../lib/notification-sounds', () => ({
  NOTIFICATION_SOUND_OPTIONS: [
    { value: 'chime', label: 'Chime' },
    { value: 'bell', label: 'Bell' },
    { value: 'pulse', label: 'Pulse' },
    { value: 'none', label: 'None' },
  ],
  previewNotificationSound,
  playDeliveredNotificationSound,
}));

import { NotificationSoundSettings } from '../NotificationSoundSettings';

describe('NotificationSoundSettings', () => {
  beforeEach(() => {
    update.mockReset();
    previewNotificationSound.mockReset();
    playDeliveredNotificationSound.mockReset();
    settings.notificationSounds = { ...DEFAULT_NOTIFICATION_SOUND_PREFERENCES };
  });

  test('persists the changed category and previews it without entering the notification delivery seam', () => {
    render(<NotificationSoundSettings />);

    fireEvent.change(
      screen.getByRole('combobox', { name: 'Job failures sound' }),
      { target: { value: 'bell' } },
    );

    expect(update).toHaveBeenCalledWith({
      notificationSounds: {
        ...DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
        'job-failure': 'bell',
      },
    });
    expect(previewNotificationSound).toHaveBeenCalledWith('bell');
    expect(playDeliveredNotificationSound).not.toHaveBeenCalled();
  });

  test('labels stopped turns separately and keeps their default sound quiet', () => {
    render(<NotificationSoundSettings />);

    expect(
      (
        screen.getByRole('combobox', {
          name: 'Stopped turns sound',
        }) as HTMLSelectElement
      ).value,
    ).toBe('chime');
  });
});
