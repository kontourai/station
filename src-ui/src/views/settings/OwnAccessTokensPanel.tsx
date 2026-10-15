import type { MintedPersonalAccessToken } from '@kontourai/station-contracts/personal-tokens';
import {
  isStationAccessUnavailable,
  useMintOwnAccessTokenMutation,
  useOwnAccessTokensQuery,
  useRevokeOwnAccessTokenMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/state';
import { errorText } from '../../utils/errorText';
import { PersonalTokens, SecretOnce } from './PersonalTokens';
import './PeopleSection.css';

/**
 * #3557: "Your access tokens", for a paired device tied to a person.
 *
 * Only such a device may manage its person's tokens; the route answers
 * anything else (the operator credential, the desktop's local grant, a device
 * tied to no one) `403 person_device_required`, and this panel then renders
 * nothing — it is not for them, which is not an error. The operator manages
 * anyone's tokens from Settings › People instead.
 *
 * Whether the person is tied by an ACCOUNT (and so cannot hold tokens) is not
 * something this route tells the caller, so "+ New" is offered and the
 * server's `account_bound_person` refusal is explained when it comes back.
 */
export function OwnAccessTokensPanel() {
  const tokens = useOwnAccessTokensQuery();
  const mint = useMintOwnAccessTokenMutation();
  const revoke = useRevokeOwnAccessTokenMutation();
  // Held above the list query, like People: a failed or refused refetch after
  // the mint must not take the only copy of the secret with it.
  const [held, setHeld] = useState<MintedPersonalAccessToken | null>(null);
  const refused = isStationAccessUnavailable(tokens.error);
  if (refused && !held) return null;
  if (tokens.isPending && !held) return null;
  const list = refused ? undefined : tokens.data;
  return (
    <div className="people__own">
      {list === undefined ? (
        <>
          {held && (
            <SecretOnce
              minted={held}
              ownerLabel="you"
              onDone={() => setHeld(null)}
            />
          )}
          {tokens.isError && !refused && (
            <ErrorState
              variant="compact"
              title="Your tokens could not be listed"
              description={errorText(tokens.error)}
              action={
                <Button size="sm" onClick={() => void tokens.refetch()}>
                  Retry
                </Button>
              }
            />
          )}
        </>
      ) : (
        <>
          <PersonalTokens
            heading="Your access tokens"
            description="A token lets a script or integration act as you, with only the access you choose and never more than this device has."
            tokens={list}
            ownerLabel="you"
            minted={held}
            mint={async (input) => {
              try {
                setHeld(await mint.mutateAsync(input));
              } finally {
                // The mutation must not keep the answer once captured.
                mint.reset();
              }
            }}
            onDone={() => setHeld(null)}
            revoke={(token) => revoke.mutateAsync(token.id)}
          />
          {tokens.isError && !refused && (
            <p className="people__error" role="alert">
              Your tokens couldn’t be refreshed: {errorText(tokens.error)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
