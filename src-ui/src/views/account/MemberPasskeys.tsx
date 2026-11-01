import { runAccountOperation } from '@kontourai/station-sdk/account-authentication';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { userFacingErrorMessage } from '../../utils/errorText';
import {
  passkeyFailureMessage,
  passkeysSupported,
  runPasskeyCeremony,
} from './member-passkeys';

interface PasskeyView {
  id: string;
  name?: string;
  createdAt: string | null;
  synced: boolean;
}

function readPasskeys(value: unknown): PasskeyView[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !('passkeys' in value) ||
    !Array.isArray(value.passkeys)
  )
    throw new Error('Station returned an unreadable passkey list.');
  return value.passkeys.filter(
    (entry): entry is PasskeyView =>
      !!entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      (entry.name === undefined || typeof entry.name === 'string') &&
      (entry.createdAt === null || typeof entry.createdAt === 'string') &&
      typeof entry.synced === 'boolean',
  );
}

/** The signed-in member's own passkeys: list, add, remove. */
export function MemberPasskeys({
  apiBase,
  paths,
  principalId,
}: {
  apiBase: string;
  paths: { list: string; add?: string; remove?: string };
  principalId: string;
}) {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<PasskeyView>();
  const key = ['account', apiBase, 'passkeys', principalId];
  const passkeys = useQuery({
    queryKey: key,
    queryFn: async () =>
      readPasskeys(await runAccountOperation(apiBase, paths.list, {})),
    retry: false,
    gcTime: 0,
  });
  const add = useMutation({
    mutationFn: () =>
      runPasskeyCeremony({
        apiBase,
        path: paths.add!,
        kind: 'register',
      }),
    onSuccess: () => setNotice('Passkey added.'),
    onError: (cause) =>
      setError(passkeyFailureMessage(cause) ?? userFacingErrorMessage(cause)),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      runAccountOperation(apiBase, paths.remove!, { id }),
    onSuccess: () => {
      setRemoving(undefined);
      setNotice('Passkey removed.');
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
  const supported = passkeysSupported();

  return (
    <section className="account-entry__passkeys" aria-labelledby="passkeys">
      <div className="account-entry__passkeys-heading">
        <h3 id="passkeys">Passkeys</h3>
        {paths.add && supported && (
          <Button
            pending={add.isPending}
            pendingLabel="Waiting for passkey…"
            onClick={() => {
              setError(undefined);
              setNotice(undefined);
              add.mutate();
            }}
          >
            Add a passkey
          </Button>
        )}
      </div>
      {passkeys.isPending ? (
        <SkeletonList count={1} label="Reading passkeys" />
      ) : passkeys.isError ? (
        <ErrorState
          variant="compact"
          title="Passkeys are unavailable"
          description={userFacingErrorMessage(passkeys.error)}
          action={
            <Button onClick={() => void passkeys.refetch()}>Try again</Button>
          }
        />
      ) : passkeys.data.length === 0 ? (
        <Empty
          variant="compact"
          label={
            supported
              ? 'No passkeys yet. Add one to sign in without a password.'
              : 'This browser cannot use passkeys.'
          }
        />
      ) : (
        <ul className="account-entry__passkey-list">
          {passkeys.data.map((entry) => (
            <li key={entry.id}>
              <div>
                <strong>{entry.name ?? 'Passkey'}</strong>
                <small>
                  {entry.createdAt
                    ? `Added ${new Date(entry.createdAt).toLocaleDateString()}`
                    : 'Added date unknown'}
                  {entry.synced ? ' · Synced' : ''}
                </small>
              </div>
              {paths.remove && (
                <Button
                  onClick={() => {
                    setError(undefined);
                    setNotice(undefined);
                    remove.reset();
                    setRemoving(entry);
                  }}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <ConfirmModal
        isOpen={!!removing}
        title="Remove this passkey?"
        message="It will no longer sign in to this Station. Signed-in sessions stay signed in."
        confirmLabel="Remove passkey"
        variant="danger"
        role="alertdialog"
        pending={remove.isPending}
        error={
          remove.isError
            ? (passkeyFailureMessage(remove.error) ??
              userFacingErrorMessage(remove.error))
            : null
        }
        onConfirm={() => removing && remove.mutate(removing.id)}
        onCancel={() => {
          setRemoving(undefined);
          remove.reset();
        }}
      />
    </section>
  );
}
