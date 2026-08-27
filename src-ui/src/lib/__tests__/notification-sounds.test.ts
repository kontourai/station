/** @vitest-environment jsdom */

import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES } from '@kontourai/station-contracts/device-settings';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  notificationSoundForCategory,
  previewNotificationSound,
} from '../notification-sounds';

describe('notification sounds', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('previews local audio without using browser notification or network APIs', () => {
    const oscillator = {
      type: 'sine',
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const fetch = vi.fn();
    const Notification = vi.fn();
    const serviceWorker = { register: vi.fn() };
    const AudioContext = vi.fn(function FakeAudioContext() {
      return {
        currentTime: 0,
        destination: {},
        createOscillator: () => oscillator,
        createGain: () => gain,
        close: () => Promise.resolve(),
      };
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('Notification', Notification);
    vi.stubGlobal('AudioContext', AudioContext);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: serviceWorker,
    });

    previewNotificationSound('bell');

    expect(AudioContext).toHaveBeenCalledOnce();
    expect(oscillator.start).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(Notification).not.toHaveBeenCalled();
    expect(serviceWorker.register).not.toHaveBeenCalled();
  });

  test('uses each stored category choice and has an audible fallback for new categories', () => {
    expect(
      notificationSoundForCategory(
        'job-failure',
        DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
      ),
    ).toBe('pulse');
    expect(
      notificationSoundForCategory(
        'future-provider-category',
        DEFAULT_NOTIFICATION_SOUND_PREFERENCES,
      ),
    ).toBe('chime');
  });
});
