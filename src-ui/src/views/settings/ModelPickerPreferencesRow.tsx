import { Button } from '../../components/Button';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  updateModelPickerPreferences,
  useModelPickerPreferences,
} from '../../settings/modelPickerPreferences';
import { SettingsPageRow } from './SettingsPageRow';
import { settingsRow } from './settings-catalog';
import { settingsDeepLinkUrl } from './settings-deep-link';

export function ModelPickerPreferencesRow() {
  const { navigate } = useNavigation();
  const preferences = useModelPickerPreferences();
  const account = useAccountPreferences();
  const previous =
    deviceSettingsStore.getEnvelope().values.modelPickerPreferences;
  const canImport =
    account.status === 'account' &&
    !account.data?.values.modelPickerPreferences &&
    previous &&
    Object.values(previous).some((entries) => entries.length > 0);
  return (
    <SettingsPageRow
      {...settingsRow('model-picker-preferences')}
      description="The model picker in your interface orders, hides, and highlights models as you arranged them."
      resetHandledByControl
      control={
        <div className="settings__row-controls">
          <Button onClick={() => navigate('/customize/providers')}>
            Open model connections
          </Button>
          <Button
            disabled={
              preferences.recents.length === 0 ||
              account.saving ||
              account.status === 'loading' ||
              account.status === 'error'
            }
            onClick={() =>
              updateModelPickerPreferences((current) => ({
                ...current,
                recents: [],
              }))
            }
          >
            Clear recent models
          </Button>
        </div>
      }
    >
      <p className="settings__field-hint">
        Favorites: {preferences.favorites.length} · Hidden:{' '}
        {preferences.hidden.length} · Ordered: {preferences.order.length} ·
        Recent: {preferences.recents.length}
      </p>
      {canImport && (
        <p className="settings__field-hint">
          Previous model picker choices are saved on this device.{' '}
          <Button
            size="sm"
            variant="link"
            onClick={() =>
              navigate(
                settingsDeepLinkUrl({
                  view: 'account-preferences',
                  highlight: 'account-preference-sync',
                }),
              )
            }
          >
            Review preference import
          </Button>
        </p>
      )}
    </SettingsPageRow>
  );
}
