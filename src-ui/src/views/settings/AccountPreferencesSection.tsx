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
      <p role="status">
        {account.status === 'account'
          ? 'Your devices share these preferences on this Station.'
          : account.status === 'loading'
            ? 'Loading preferences…'
            : account.status === 'error'
              ? 'Sync unavailable. Reload to try again.'
              : 'Saved on this device. Sign in to sync.'}
      </p>
      <div className="settings__account-help">
        <details>
          <summary>About these preferences</summary>
          <p>
            Appearance, chat display, diff preferences, model favorites, and
            new-chat defaults follow your account on this Station. Other devices
            refresh when you return or reconnect.
          </p>
          <p>
            Microphone, speakers, push permission, haptics, keyboard, layout,
            and access grants stay on each device. Other Stations keep separate
            preferences.
          </p>
          <p>
            Approval defaults: Chat choice → Agent → your default → Station →
            engine. Existing chats and unattended jobs keep their settings.
          </p>
        </details>
      </div>
      <PageRow
        {...settingsRow('account-preference-sync')}
        description="Fills account choices you haven’t saved yet."
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
              : undefined
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
                    ? 'Use inherited default'
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
        message={`New ${confirmEngine ?? ''} chats will request Full access. The agent can act without approval prompts, subject to this device’s access and Station policy.`}
        confirmLabel="Save full access default"
        cancelLabel="Cancel"
        variant="danger"
        onCancel={() => setConfirmEngine(null)}
        onConfirm={() => {
          if (confirmEngine) saveMode(confirmEngine, 'never');
          setConfirmEngine(null);
        }}
      />
      {account.saving && (
        <p role="status">
          {account.waitingForConnection
            ? 'Waiting for connection. Changes aren’t saved yet.'
            : 'Saving account preferences…'}
        </p>
      )}
      {(account.error || account.status === 'error') && (
        <p role="alert">
          {account.conflict
            ? 'Changed on another device. Reload before trying again.'
            : 'Couldn’t confirm the save.'}{' '}
          <Button onClick={account.retry}>Reload saved preferences</Button>
        </p>
      )}
    </SettingsSection>
  );
}
