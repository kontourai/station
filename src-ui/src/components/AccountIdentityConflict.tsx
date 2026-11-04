import { runAccountOperation } from '@kontourai/station-sdk/account-authentication';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { userFacingErrorMessage } from '../utils/errorText';
import { Button } from './Button';
import { ErrorState } from './state';

export function isAccountIdentityConflict(error: unknown): boolean {
  return (
    error instanceof StationHttpError &&
    error.status === 403 &&
    error.code === 'account_identity_conflict'
  );
}

export function AccountIdentityConflict({
  apiBase,
  onRecovered,
}: {
  apiBase: string;
  onRecovered: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function signOut() {
    setPending(true);
    setError(undefined);
    try {
      await runAccountOperation(apiBase, '/sign-out', {});
      onRecovered();
    } catch (cause) {
      setError(userFacingErrorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <ErrorState
      title="Account sign-in conflicts with owner controls"
      description={
        error ??
        'This browser is signed in to a Station account. Sign out of that account to use owner controls.'
      }
      action={
        <Button
          variant="primary"
          pending={pending}
          onClick={() => void signOut()}
        >
          Sign out of account
        </Button>
      }
    />
  );
}
