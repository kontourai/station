import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';

export function ChangelogPreference() {
  const { showReleaseNotesAfterUpdate } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  return (
    <label className="release-notes__preference">
      <input
        type="checkbox"
        checked={showReleaseNotesAfterUpdate}
        onChange={(event) =>
          setDeviceSetting('showReleaseNotesAfterUpdate', event.target.checked)
        }
      />
      Show changelog after updates
    </label>
  );
}
