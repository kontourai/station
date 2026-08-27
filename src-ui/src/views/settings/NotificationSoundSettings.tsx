import {
  NOTIFICATION_SOUND_CATEGORIES,
  type NotificationSound,
} from '@kontourai/station-contracts/device-settings';
import { useFeatureSettings } from '../../hooks/useFeatureSettings';
import {
  NOTIFICATION_SOUND_OPTIONS,
  previewNotificationSound,
} from '../../lib/notification-sounds';

const CATEGORY_LABELS: Record<
  (typeof NOTIFICATION_SOUND_CATEGORIES)[number],
  string
> = {
  'approval-request': 'Approval requests',
  'pairing-request': 'Pairing requests',
  'job-failure': 'Job failures',
  'job-missed': 'Missed jobs',
  'scheduler-unhealthy': 'Scheduler health',
  'turn-failed': 'Failed turns',
  'turn-completed': 'Completed turns',
  'turn-stopped': 'Stopped turns',
};

/** Device-local sound choices for the categories currently emitted by Station. */
export function NotificationSoundSettings() {
  const { settings, update } = useFeatureSettings();

  return (
    <fieldset className="settings__notification-sounds">
      <legend>Notification sounds</legend>
      <p className="settings__notification-sounds-help">
        Choose a sound for each notification category. Changes play a local
        preview only; they do not send a notification.
      </p>
      <div className="settings__notification-sounds-grid">
        {NOTIFICATION_SOUND_CATEGORIES.map((category) => {
          const id = `notification-sound-${category}`;
          return (
            <label key={category} className="settings__notification-sound">
              <span>{CATEGORY_LABELS[category]}</span>
              <select
                id={id}
                aria-label={`${CATEGORY_LABELS[category]} sound`}
                value={settings.notificationSounds[category]}
                onChange={(event) => {
                  const sound = event.currentTarget.value as NotificationSound;
                  update({
                    notificationSounds: {
                      ...settings.notificationSounds,
                      [category]: sound,
                    },
                  });
                  previewNotificationSound(sound);
                }}
              >
                {NOTIFICATION_SOUND_OPTIONS.map((sound) => (
                  <option key={sound.value} value={sound.value}>
                    {sound.label}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
