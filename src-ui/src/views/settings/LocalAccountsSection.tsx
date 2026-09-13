import type {
  LocalAccountAction,
  LocalAccountView,
} from '@kontourai/station-contracts/local-accounts';
import {
  changeLocalAccount,
  getLocalAccounts,
} from '@kontourai/station-sdk/local-accounts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import { ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { errorText } from '../../utils/errorText';

export function LocalAccountsSection() {
  const authority = useHostRequestAuthorityScope();
  return authority ? (
    <AccountControls
      key={`${authority.apiBase}:${authority.authorityKey}`}
      authority={authority}
    />
  ) : null;
}
function AccountControls({
  authority,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const client = useQueryClient();
  const key = ['operator-accounts', authority.apiBase, authority.authorityKey];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      getLocalAccounts(authority.apiBase, { requestScope: authority, signal }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: (input: {
      account: LocalAccountView;
      action: LocalAccountAction;
    }) =>
      changeLocalAccount(
        authority.apiBase,
        input.account.accountId,
        input.action,
        { requestScope: authority },
      ),
  });
  const [pending, setPending] = useState<{
    account: LocalAccountView;
    action: LocalAccountAction;
  }>();
  const [recovery, setRecovery] = useState<string>();
  const [error, setError] = useState<string>();
  const busy = mutation.isPending || query.isFetching;
  async function apply() {
    if (!pending) return;
    setError(undefined);
    setRecovery(undefined);
    try {
      const result = await mutation.mutateAsync(pending);
      if ('recoveryUrl' in result) setRecovery(result.recoveryUrl);
      setPending(undefined);
      await client.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      mutation.reset();
    }
  }
  return (
    <PageSection
      className="settings__section local-accounts"
      title="Accounts and sign-in"
      description="Station operators manage account sign-in here. Project roles, device approvals and computer access remain separate."
    >
      {query.isPending ? (
        <SkeletonList count={2} />
      ) : query.isError ? (
        <ErrorState
          title="Account administration unavailable"
          description={errorText(query.error)}
        />
      ) : query.data.kind === 'none' ? (
        <p>Local accounts are not enabled on this Station.</p>
      ) : query.data.kind === 'external' ? (
        <p>
          Accounts are managed by {query.data.provider}. Manage their sign-in
          and recovery with that provider.
        </p>
      ) : query.data.accounts.length === 0 ? (
        <p>
          No accounts yet. Create a Project invitation link to invite someone.
        </p>
      ) : (
        query.data.accounts.map((account) => (
          <div className="local-accounts__row" key={account.accountId}>
            <div>
              <strong>{account.name}</strong>
              <p>
                {account.username ?? account.email} ·{' '}
                {account.disabled ? 'Sign-in disabled' : 'Active'}
              </p>
            </div>
            <div className="local-accounts__actions">
              <Button
                disabled={busy}
                onClick={() =>
                  setPending({
                    account,
                    action: account.disabled ? 'enable' : 'disable',
                  })
                }
              >
                {account.disabled ? 'Enable sign-in' : 'Disable sign-in'}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  setPending({ account, action: 'revoke-sessions' })
                }
              >
                Sign out all sessions
              </Button>
              <Button
                disabled={busy || account.disabled}
                onClick={() =>
                  setPending({ account, action: 'create-recovery' })
                }
              >
                Create recovery link
              </Button>
            </div>
          </div>
        ))
      )}
      {recovery && (
        <div>
          <label>
            Single-use recovery link
            <input
              readOnly
              value={recovery}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p>
            Share this privately with the account owner after confirming who
            they are. Resetting the password signs out their existing sessions.
          </p>
          <Button onClick={() => setRecovery(undefined)}>Dismiss link</Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <ConfirmModal
        isOpen={!!pending}
        pending={mutation.isPending}
        error={error}
        title={
          pending?.action === 'create-recovery'
            ? 'Create a password recovery link?'
            : 'Change account sign-in?'
        }
        message={
          pending?.action === 'create-recovery'
            ? `Anyone with this link can reset ${pending.account.name}’s password. Confirm the recipient before sharing it.`
            : `Apply this account action to ${pending?.account.name ?? 'this account'}? Project membership and device grants will remain recorded separately.`
        }
        onConfirm={() => void apply()}
        onCancel={() => setPending(undefined)}
      />
    </PageSection>
  );
}
