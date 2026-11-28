import {
  ACCOUNT_PREFERENCE_KEYS,
  type AccountPreferencesPatch,
  INTERACTIVE_APPROVAL_ENGINES,
  type InteractiveApprovalEngine,
} from '@kontourai/station-contracts/account-preferences';
import { useEngineConnectionsQuery } from '@kontourai/station-sdk';
import { applyReturnFocus } from '@kontourai/station-shared/return-focus';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ManagedApprovalCeilingNote } from '../../components/managed/ManagedApprovalCeilingNote';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { ErrorState } from '../../components/state';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { useManagedApprovalCeiling } from '../../contexts/ManagedPolicyContext';
import { DEFAULT_CHAT_SEND_MODE } from '../../lib/account-preference-values';
import { useDecisionSurface } from '../../lib/custom-appearance/decision-surfaces';
import { deviceSettingsStore } from '../../lib/device-settings-store';
import {
  APPROVAL_MODE_OPTIONS,
  approvalModeDescription,
  approvalModeLabel,
} from '../../utils/approvalMode';
import { connectionEngineId } from '../../utils/execution';
import { SettingsPageRow as PageRow } from './SettingsPageRow';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

type ApprovalRow = 'all' | InteractiveApprovalEngine;

export function AccountPreferencesSection() {
  useDecisionSurface('account-approval-defaults');
  const account = useAccountPreferences();
  const { aboveCeiling } = useManagedApprovalCeiling();
  const recoveryRegion = useRef<HTMLElement>(null);
  const retryTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const trigger = retryTrigger.current;
    retryTrigger.current = null;
    if (!account.retrying || !trigger) return;
    const frame = requestAnimationFrame(() => {
      const region = recoveryRegion.current;
      if (
        !document.hasFocus() ||
        document.visibilityState !== 'visible' ||
        !region?.isConnected ||
        !trigger.isConnected
      )
        return;
      applyReturnFocus([region], trigger);
      if (document.activeElement === region)
        region.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: 'instant',
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [account.retrying]);
  const [confirmEngine, setConfirmEngine] = useState<ApprovalRow | null>(null);
  const approvalRows = {
    all: settingsRow('personal-all-engines-approval'),
    codex: settingsRow('personal-codex-approval'),
    claude: settingsRow('personal-claude-approval'),
    muse: settingsRow('personal-muse-approval'),
    opencode: settingsRow('personal-opencode-approval'),
    acp: settingsRow('personal-acp-approval'),
    antigravity: settingsRow('personal-antigravity-approval'),
  };
  const defaults = account.data?.values.interactiveApprovalModes ?? {};
  const allEnginesDefault = account.data?.values.interactiveApprovalDefault;
  const { data: engineConnections = [] } = useEngineConnectionsQuery();
  const connectedEngines = new Set(engineConnections.map(connectionEngineId));
  const rows: ApprovalRow[] = [
    'all',
    ...INTERACTIVE_APPROVAL_ENGINES.filter(
      (engine) =>
        engine === 'codex' ||
        engine === 'claude' ||
        connectedEngines.has(engine) ||
        defaults[engine] !== undefined,
    ),
  ];
  const saveMode = (row: ApprovalRow, mode: string) => {
    if (
      mode !== 'connection-default' &&
      mode !== 'ask' &&
      mode !== 'auto' &&
      mode !== 'never'
    )
      return;
    if (aboveCeiling(mode)) return;
    const value = mode === 'connection-default' ? null : mode;
    account.save(
      row === 'all'
        ? { interactiveApprovalDefault: value }
        : { interactiveApprovalModes: { [row]: value } },
    );
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
            Approval order: Chat choice → Agent → Project → engine override →
            all-engines default → Station → engine.
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
      <PageRow
        {...settingsRow('chat-default-send-mode')}
        description="Choose how messages are sent during a running turn."
        control={
          <select
            className="editor-select"
            aria-label="Default send mode"
            disabled={account.saving || account.status !== 'account'}
            value={
              account.data?.values.chatDefaultSendMode ?? DEFAULT_CHAT_SEND_MODE
            }
            onChange={(event) =>
              account.save({
                chatDefaultSendMode:
                  event.target.value === 'steer'
                    ? 'steer'
                    : DEFAULT_CHAT_SEND_MODE,
              })
            }
          >
            <option value="queue">Queue</option>
            <option value="steer">Steer</option>
          </select>
        }
      />
      {rows.map((row) => {
        const selected = row === 'all' ? allEnginesDefault : defaults[row];
        const fallback =
          row !== 'all' && allEnginesDefault
            ? `All engines (${approvalModeLabel(allEnginesDefault)})`
            : 'Station or engine default';
        return (
          <PageRow
            key={row}
            {...approvalRows[row]}
            description={
              selected
                ? approvalModeDescription(
                    selected,
                    row === 'all' ? undefined : row,
                  )
                : undefined
            }
            control={
              <select
                className="editor-select"
                aria-label={`${approvalRows[row].title} approval mode`}
                disabled={account.saving || account.status !== 'account'}
                value={selected ?? 'connection-default'}
                onChange={(event) =>
                  event.target.value === 'never' && selected !== 'never'
                    ? setConfirmEngine(row)
                    : saveMode(row, event.target.value)
                }
              >
                {APPROVAL_MODE_OPTIONS.map((option) => {
                  // #4518: a personal default above this Station's managed
                  // ceiling is not offered; one already saved stays shown, and
                  // the server lowers it where it applies.
                  const managed =
                    aboveCeiling(option.value) && option.value !== selected;
                  return (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={managed}
                    >
                      {option.value === 'connection-default'
                        ? fallback
                        : managed
                          ? `${option.label} (Managed)`
                          : option.label}
                    </option>
                  );
                })}
              </select>
            }
          />
        );
      })}
      <ManagedApprovalCeilingNote className="editor-hint" />
      <ConfirmModal
        isOpen={confirmEngine !== null}
        title="Save full access default?"
        message={`${confirmEngine ? approvalRows[confirmEngine].title : 'New chats'} will request Full access. The agent can act without approval prompts, subject to this device’s access and Station policy.`}
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
      <section
        ref={recoveryRegion}
        aria-label="Account preference recovery"
        tabIndex={-1}
      >
        {account.status !== 'error' && (
          <p role="status">
            {account.status === 'account'
              ? 'Your devices share these preferences on this Station.'
              : account.status === 'loading'
                ? 'Loading preferences…'
                : 'Saved on this device. Sign in to sync.'}
          </p>
        )}
        {(account.error || account.status === 'error') && (
          <ErrorState
            variant="compact"
            title={
              account.status === 'error'
                ? 'Couldn’t load your account preferences.'
                : account.conflict
                  ? 'Changed on another device. Reload before trying again.'
                  : 'Couldn’t confirm the save.'
            }
            action={
              <Button
                onClick={(event) => {
                  retryTrigger.current =
                    document.activeElement === event.currentTarget
                      ? event.currentTarget
                      : null;
                  account.retry();
                }}
                pending={account.retrying}
                pendingLabel="Loading preferences…"
              >
                {account.status === 'error'
                  ? 'Retry loading preferences'
                  : 'Reload saved preferences'}
              </Button>
            }
          />
        )}
      </section>
    </SettingsSection>
  );
}
