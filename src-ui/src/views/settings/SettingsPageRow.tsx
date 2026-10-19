import { ACCOUNT_PREFERENCE_KEYS } from '@kontourai/station-contracts/account-preferences';
import type { ComponentProps } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { SETTINGS_CATALOG } from './settings-catalog';

export function SettingsPageRow(props: ComponentProps<typeof PageRow>) {
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
    hasAccountValue ||
    (isAnswerDelivery &&
      (account.data?.values.smoothReveal !== undefined ||
        account.data?.values.bufferedDelivery !== undefined));
  const label =
    entry?.section === 'account-preferences'
      ? undefined
      : entry?.scope === 'account'
        ? account.status === 'account'
          ? 'Account · this Station'
          : account.status === 'loading'
            ? 'Account preferences loading'
            : account.status === 'error'
              ? 'Account preferences unavailable'
              : 'This device · sign in to share'
        : entry?.scope === 'device'
          ? 'This device'
          : undefined;
  return (
    <PageRow
      {...props}
      statusPlacement="label"
      status={
        label ? (
          <>
            {props.status}
            <span className="settings__row-scope">{label}</span>
            {account.status === 'account' && canReset && (
              <Button
                size="sm"
                variant="link"
                disabled={account.saving}
                aria-label={`Use default for ${entry?.title ?? key}`}
                title="Remove your saved choice and use the built-in default."
                onClick={() =>
                  account.save(
                    key
                      ? { [key]: null }
                      : { smoothReveal: null, bufferedDelivery: null },
                  )
                }
              >
                Use default
              </Button>
            )}
          </>
        ) : (
          props.status
        )
      }
    />
  );
}
