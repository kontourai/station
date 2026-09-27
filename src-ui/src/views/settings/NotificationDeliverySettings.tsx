import { type NotificationUrgency } from '@kontourai/station-contracts/notification';
import {
  type AgentNotificationLevel,
  defaultNotificationPreferences,
  type NotificationPreferencesPatch,
} from '@kontourai/station-contracts/notification-preferences';
import {
  useNotificationPreferencesQuery,
  usePairedDevicesQuery,
  usePatchNotificationPreferencesMutation,
  useUpdateNotificationPreferencesMutation,
} from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { ErrorState, SkeletonBlock } from '../../components/state';

const LEVELS: Array<{ value: AgentNotificationLevel; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'attention-only', label: 'Only requests and failures' },
  { value: 'off', label: 'Off (inbox only)' },
];

const URGENCIES: Array<{ value: NotificationUrgency; label: string }> = [
  { value: 'info', label: 'Everything' },
  { value: 'done', label: 'Finished and above' },
  { value: 'failed', label: 'Failures and above' },
  { value: 'attention', label: 'Only when needed' },
];

const DEFAULT_QUIET_HOURS = {
  start: '22:00',
  end: '07:00',
  allowAttention: true,
};

/** Quiet hours are read in the person's zone on the server; this is it. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Station-wide delivery preferences (#2586): how far notifications may
 * interrupt beyond the inbox. Every change saves at once as a PATCH of
 * that one field; there is no draft state to lose.
 */
export default function NotificationDeliverySettings() {
  const preferences = useNotificationPreferencesQuery();
  const update = useUpdateNotificationPreferencesMutation();
  const patch = usePatchNotificationPreferencesMutation();
  const devices = usePairedDevicesQuery();

  if (preferences.isLoading) {
    return <SkeletonBlock count={1} label="Loading notification delivery" />;
  }
  if (preferences.error || !preferences.data) {
    // Only a saved file the server cannot read is replaced by a reset; a
    // transient failure (offline, 5xx) must never offer to wipe the
    // person's choices. The SDK sends the unreadable revision as If-Match,
    // so the reset loses to anyone who repaired the file meanwhile.
    const unreadable =
      (preferences.error as { code?: string } | null)?.code ===
      'preferences_unreadable';
    return (
      <ErrorState
        title="Notification delivery settings could not be loaded"
        description={preferences.error?.message}
        action={
          unreadable ? (
            <Button
              size="sm"
              pending={update.isPending}
              onClick={() => update.mutate(defaultNotificationPreferences())}
            >
              Reset to defaults
            </Button>
          ) : (
            <Button size="sm" onClick={() => void preferences.refetch()}>
              Retry
            </Button>
          )
        }
      />
    );
  }

  const current = preferences.data;
  // One field at a time, applied server-side: a mute made elsewhere in the
  // meantime is never overwritten by this screen's older copy.
  const save = (next: NotificationPreferencesPatch) => patch.mutate(next);
  const disabled = patch.isPending || update.isPending;
  const quiet = current.quietHours;
  const activeDevices = (devices.data ?? []).filter(
    (device) => device.revokedAt === null,
  );

  return (
    <fieldset
      className="settings__notification-sounds"
      data-testid="notification-delivery"
    >
      <legend>Notification delivery</legend>
      <p className="settings__notification-sounds-help">
        Where notifications may interrupt you beyond the inbox. The inbox always
        keeps everything.
      </p>
      <div className="settings__notification-sounds-grid">
        <label className="settings__notification-sound">
          <span>Agent notifications</span>
          <select
            aria-label="Agent notifications"
            value={current.agentNotifications}
            disabled={disabled}
            onChange={(event) =>
              save({
                agentNotifications: event.currentTarget
                  .value as AgentNotificationLevel,
              })
            }
          >
            {LEVELS.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings__notification-sound">
          <span>Quiet hours</span>
          <input
            type="checkbox"
            aria-label="Quiet hours"
            checked={quiet !== undefined}
            disabled={disabled}
            onChange={(event) => {
              if (event.currentTarget.checked)
                save({
                  quietHours: {
                    ...DEFAULT_QUIET_HOURS,
                    timeZone: browserTimeZone(),
                  },
                });
              else {
                save({ quietHours: null });
              }
            }}
          />
        </label>
        {quiet && (
          <>
            <label className="settings__notification-sound">
              <span>From</span>
              <input
                type="time"
                aria-label="Quiet hours start"
                value={quiet.start}
                disabled={disabled}
                onChange={(event) => {
                  const start = event.currentTarget.value;
                  if (start && start !== quiet.end)
                    save({ quietHours: { ...quiet, start } });
                }}
              />
            </label>
            <label className="settings__notification-sound">
              <span>Until</span>
              <input
                type="time"
                aria-label="Quiet hours end"
                value={quiet.end}
                disabled={disabled}
                onChange={(event) => {
                  const end = event.currentTarget.value;
                  if (end && end !== quiet.start)
                    save({ quietHours: { ...quiet, end } });
                }}
              />
            </label>
            <label className="settings__notification-sound">
              <span>Let urgent requests through</span>
              <input
                type="checkbox"
                aria-label="Let urgent requests through during quiet hours"
                checked={quiet.allowAttention}
                disabled={disabled}
                onChange={(event) =>
                  save({
                    quietHours: {
                      ...quiet,
                      allowAttention: event.currentTarget.checked,
                    },
                  })
                }
              />
            </label>
          </>
        )}
      </div>
      {activeDevices.length > 0 && (
        <>
          <p className="settings__notification-sounds-help">
            Per device: what may interrupt it, and whether its lock screen shows
            what a notification says.
          </p>
          <div className="settings__notification-sounds-grid">
            {activeDevices.map((device) => {
              const surface = `device:${device.id}`;
              const surfacePrefs = current.perSurface[surface] ?? {
                minUrgency: 'info' as const,
                hideContent: false,
              };
              const setSurface = (next: typeof surfacePrefs) =>
                save({ perSurface: { [surface]: next } });
              return (
                <div key={device.id} className="settings__notification-sound">
                  <span>{device.name}</span>
                  <select
                    aria-label={`${device.name}: interrupt for`}
                    value={surfacePrefs.minUrgency}
                    disabled={disabled}
                    onChange={(event) =>
                      setSurface({
                        ...surfacePrefs,
                        minUrgency: event.currentTarget
                          .value as NotificationUrgency,
                      })
                    }
                  >
                    {URGENCIES.map((urgency) => (
                      <option key={urgency.value} value={urgency.value}>
                        {urgency.label}
                      </option>
                    ))}
                  </select>
                  <label>
                    <input
                      type="checkbox"
                      checked={surfacePrefs.hideContent}
                      disabled={disabled}
                      onChange={(event) =>
                        setSurface({
                          ...surfacePrefs,
                          hideContent: event.currentTarget.checked,
                        })
                      }
                    />{' '}
                    Hide content
                  </label>
                </div>
              );
            })}
          </div>
        </>
      )}
      {(patch.error ?? update.error) && (
        <div className="settings__notif-error" role="alert">
          {(patch.error ?? update.error)?.message}
        </div>
      )}
    </fieldset>
  );
}
