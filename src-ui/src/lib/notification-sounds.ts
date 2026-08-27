import type {
  NotificationSound,
  NotificationSoundPreferences,
} from '@kontourai/station-contracts/device-settings';

const SOUND_FREQUENCIES: Record<
  Exclude<NotificationSound, 'none'>,
  readonly [number, number]
> = {
  chime: [880, 1_176],
  bell: [660, 880],
  pulse: [392, 523.25],
};

export const NOTIFICATION_SOUND_OPTIONS: ReadonlyArray<{
  value: NotificationSound;
  label: string;
}> = [
  { value: 'chime', label: 'Chime' },
  { value: 'bell', label: 'Bell' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'none', label: 'None' },
];

function createAudioContext(): AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const AudioContextConstructor =
    window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;
  return AudioContextConstructor ? new AudioContextConstructor() : undefined;
}

/**
 * Plays only local synthesized audio. This intentionally has no fetch,
 * Notification, service-worker, or server-event dependency, so a settings
 * preview cannot create or deliver a notification.
 */
export function previewNotificationSound(sound: NotificationSound): void {
  if (sound === 'none') return;
  const context = createAudioContext();
  if (!context) return;

  const [startFrequency, endFrequency] = SOUND_FREQUENCIES[sound];
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = sound === 'pulse' ? 'square' : 'sine';
  oscillator.frequency.setValueAtTime(startFrequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.13, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.21);
  oscillator.addEventListener('ended', () => {
    void context.close().catch(() => undefined);
  });
}

/** Resolves a stored category preference, preserving a safe audible fallback for new categories. */
export function notificationSoundForCategory(
  category: string,
  preferences: NotificationSoundPreferences,
): NotificationSound {
  return preferences[category as keyof NotificationSoundPreferences] ?? 'chime';
}

/** The foreground notification seam calls this after a real delivery arrives. */
export function playDeliveredNotificationSound(
  category: string,
  preferences: NotificationSoundPreferences,
): void {
  previewNotificationSound(notificationSoundForCategory(category, preferences));
}
