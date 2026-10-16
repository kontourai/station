import { useEffect } from 'react';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { applyAccentColor } from '../../lib/accent-contrast';
import { SettingsPageRow } from './SettingsPageRow';
import { settingsRow } from './settings-catalog';

/** Exported so the contrast tests measure the shipped list, not a copy. */
export const ACCENT_PRESETS = [
  '#6366f1',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
];

export function AccentColorPicker() {
  const account = useAccountPreferences();
  const { accentColor } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const color = accentColor ?? '';

  // Keyed on the store VALUE, not the click handler (archive#settings-
  // revamp): applies the DOM side effect however
  // the value changed — a click here, an import elsewhere on this same
  // page, or a cross-tab sync — instead of only the one path this
  // component's own click handler drives. An imported/reset `null` accent
  // removes the override the same way a manual Reset click does.
  useEffect(() => {
    applyAccentColor(document.documentElement, accentColor);
  }, [accentColor]);

  const apply = (nextColor: string) => {
    setDeviceSetting('accentColor', nextColor || null);
  };

  return (
    <SettingsPageRow
      {...settingsRow('accent-color')}
      description="Choose an accent color for your interface."
      control={
        <div className="settings__accent-row">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`settings__accent-swatch${color === preset ? ' settings__accent-swatch--active' : ''}`}
              style={{ background: preset }}
              onClick={() => apply(preset)}
              aria-label={`Accent color ${preset}`}
            />
          ))}
          <input
            type="color"
            className="settings__accent-custom"
            value={color || '#6366f1'}
            onChange={(event) => apply(event.target.value)}
            aria-label="Custom accent color"
          />
          {color && account.status !== 'account' && (
            <button
              type="button"
              className="settings__accent-reset"
              onClick={() => apply('')}
            >
              Use default
            </button>
          )}
        </div>
      }
    />
  );
}
