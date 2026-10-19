import { ACCOUNT_PREFERENCE_KEYS } from '@kontourai/station-contracts/account-preferences';
import { DEVICE_SETTINGS_REGISTRY } from '@kontourai/station-contracts/device-settings';
import type { ComponentProps } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { SettingsScopeBadge } from './SettingsScopeBadge';
import { SETTINGS_CATALOG } from './settings-catalog';

export function SettingsPageRow({
  resetHandledByControl = false,
  ...props
}: ComponentProps<typeof PageRow> & { resetHandledByControl?: boolean }) {
  const account = useAccountPreferences();
  const entry = SETTINGS_CATALOG.find(
    (row) => row.id === props['data-catalog-id'],
  );
  const key = ACCOUNT_PREFERENCE_KEYS.find((candidate) =>
    entry?.configKeys?.includes(candidate),
  );
  const hasAccountValue =
    key !== undefined && Object.hasOwn(account.data?.values ?? {}, key);
  const isAnswerDelivery = entry?.id === 'smooth-answer-reveal';
  const canReset =
    !resetHandledByControl &&
    DEVICE_SETTINGS_REGISTRY.find((definition) => definition.key === key)
      ?.descriptor.kind !== 'boolean' &&
    (hasAccountValue ||
      (isAnswerDelivery &&
        (account.data?.values.smoothReveal !== undefined ||
          account.data?.values.bufferedDelivery !== undefined)));
  const label =
    entry?.section === 'account-preferences'
      ? undefined
      : entry?.scope === 'account'
        ? account.status === 'account'
          ? 'Account'
          : account.status === 'loading'
            ? 'Account loading'
            : account.status === 'error'
              ? 'Account unavailable'
              : 'This device'
        : entry?.scope === 'device'
          ? 'This device'
          : undefined;
  return (
    <PageRow
      {...props}
      statusPlacement="label"
      control={
        account.status === 'account' && canReset ? (
          <div className="settings__row-controls">
            {props.control}
            <Button
              size="sm"
              variant="link"
              disabled={account.saving}
              aria-label={`Reset ${entry?.title ?? key} to default`}
              title="Reset this preference to its default."
              onClick={() =>
                account.save(
                  key
                    ? { [key]: null }
                    : { smoothReveal: null, bufferedDelivery: null },
                )
              }
            >
              Reset
            </Button>
          </div>
        ) : (
          props.control
        )
      }
      status={
        label ? (
          <>
            {props.status}
            <SettingsScopeBadge
              scope={
                entry?.scope === 'account' && account.status !== 'device'
                  ? 'account'
                  : 'device'
              }
              label={label}
              description={
                entry?.scope === 'account' && account.status === 'loading'
                  ? 'Account preferences are loading.'
                  : entry?.scope === 'account' && account.status === 'error'
                    ? 'Account preferences could not be loaded.'
                    : undefined
              }
            />
          </>
        ) : (
          props.status
        )
      }
    />
  );
}
