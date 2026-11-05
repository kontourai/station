import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { SettingsToggle } from '../../views/settings/feature-toggle';

export function ChangelogPreference() {
  const { showReleaseNotesAfterUpdate } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  return (
    <SettingsToggle
      className="release-notes__preference"
      checked={showReleaseNotesAfterUpdate}
      label="Show changelog after updates"
      onChange={() =>
        setDeviceSetting(
          'showReleaseNotesAfterUpdate',
          !showReleaseNotesAfterUpdate,
        )
      }
    >
      <span>Show changelog after updates</span>
    </SettingsToggle>
  );
}
