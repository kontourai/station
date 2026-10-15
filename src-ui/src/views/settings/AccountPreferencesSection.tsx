import {
  ACCOUNT_PREFERENCE_KEYS,
  type AccountPreferencesPatch,
  type InteractiveApprovalEngine,
} from '@kontourai/station-contracts/account-preferences';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  APPROVAL_MODE_OPTIONS,
  approvalModeDescription,
} from '../../utils/approvalMode';
import { SettingsPageRow as PageRow } from './SettingsPageRow';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

export function AccountPreferencesSection() {
  const account = useAccountPreferences();
  const [confirmEngine, setConfirmEngine] =
    useState<InteractiveApprovalEngine | null>(null);
  const engineRows = {
    codex: settingsRow('personal-codex-approval'),
    claude: settingsRow('personal-claude-approval'),
    muse: settingsRow('personal-muse-approval'),
  };
  const defaults = account.data?.values.interactiveApprovalModes ?? {};
  const saveMode = (engine: InteractiveApprovalEngine, mode: string) => {
    if (
      mode === 'connection-default' ||
      mode === 'ask' ||
      mode === 'auto' ||
      mode === 'never'
    )
      account.save({
        interactiveApprovalModes: {
          [engine]: mode === 'connection-default' ? null : mode,
        },
      });
  };
  const importPrevious = () => {
    const local = deviceSettingsStore.getEnvelope().values;
    const patch: AccountPreferencesPatch = {};
    for (const key of ACCOUNT_PREFERENCE_KEYS)
      if (
        Object.hasOwn(local, key) &&
        !Object.hasOwn(account.data?.values ?? {}, key)
      )
        Object.assign(patch, { [key]: local[key] });
    for (const key of ['smoothReveal', 'bufferedDelivery'] as const)
      if (
        local.featureSettings?.[key] !== undefined &&
        account.data?.values[key] === undefined
      )
        patch[key] = local.featureSettings[key];
    account.save(patch, true);
  };
  return (
    <SettingsSection
      icon="◉"
      title="Your account preferences"
      id="section-account-preferences"
    >
      <p>
        {account.status === 'account'
          ? 'Saved to your account on this Station and used by your other signed-in devices. Changes to display preferences apply after saving.'
          : account.status === 'loading'
            ? 'Loading your account preferences. Saved preferences have not been confirmed yet.'
            : account.status === 'error'
              ? 'Account preferences could not be loaded. Account settings are unavailable; this device keeps its local preferences.'
              : 'Using preferences saved on this device. Sign in as the same person on each device to share preferences on this Station.'}
      </p>
      <p>
        Microphone and output providers, push permission, haptics, keyboard
        behavior, shortcuts, panel sizes, and device access stay on this device.
        Project and Station settings remain shared configuration.
      </p>
      <p>
        Your interactive chats only. An explicit chat choice wins, then the
        Agent’s default, then your preference. Changes apply to new chats;
        existing chats and unattended jobs keep their settings.
      </p>
      <>
        <PageRow
          {...settingsRow('account-preference-sync')}
          description="Imports only choices your account has not saved. The local copy is kept; permission defaults are never imported."
          control={
            <Button
              disabled={account.saving || account.status !== 'account'}
              onClick={importPrevious}
            >
              Import previous preferences
            </Button>
          }
        />
        {(['codex', 'claude', 'muse'] as const).map((engine) => (
          <PageRow
            key={engine}
            {...engineRows[engine]}
            description={
              defaults[engine]
                ? approvalModeDescription(defaults[engine]!, engine)
                : 'Uses the Agent, then Station, then engine default.'
            }
            control={
              <select
                className="editor-select"
                aria-label={`New ${engine} chats approval mode`}
                disabled={account.saving || account.status !== 'account'}
                value={defaults[engine] ?? 'connection-default'}
                onChange={(event) =>
                  event.target.value === 'never' && defaults[engine] !== 'never'
                    ? setConfirmEngine(engine)
                    : saveMode(engine, event.target.value)
                }
              >
                {APPROVAL_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value === 'connection-default'
                      ? 'Follow Agent / Station / engine'
                      : option.label}
                  </option>
                ))}
              </select>
            }
          />
        ))}
        <ConfirmModal
          isOpen={confirmEngine !== null}
          title="Save full access default?"
          message={`${approvalModeDescription('never', confirmEngine)} This becomes the saved default for your new ${confirmEngine ?? ''} chats, subject to device access and Station policy.`}
          confirmLabel="Save full access default"
          cancelLabel="Cancel"
          variant="danger"
          onCancel={() => setConfirmEngine(null)}
          onConfirm={() => {
            if (confirmEngine) saveMode(confirmEngine, 'never');
            setConfirmEngine(null);
          }}
        />
      </>
      {account.saving && <p role="status">Saving account preferences…</p>}
      {(account.error || account.status === 'error') && (
        <p role="alert">
          Preferences were not saved or refreshed.{' '}
          <Button onClick={account.retry}>Reload saved preferences</Button>
        </p>
      )}
    </SettingsSection>
  );
}
