import {
  isStationAccessUnavailable,
  useMintOwnAccessTokenMutation,
  useOwnAccessTokensQuery,
  useRevokeOwnAccessTokenMutation,
} from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { ErrorState } from '../../components/state';
import { errorText } from '../../utils/errorText';
import { PersonalTokens } from './PersonalTokens';
import './PeopleSection.css';

/**
 * #3557: "Your access tokens", for a paired device tied to a person.
 *
 * Only such a device may manage its person's tokens; the route answers
 * anything else (the operator credential, the desktop's local grant, a device
 * tied to no one) `403 person_device_required`, and this panel then renders
 * nothing — it is not for them, which is not an error. The operator manages
 * anyone's tokens from Settings › People instead.
 */
export function OwnAccessTokensPanel() {
  const tokens = useOwnAccessTokensQuery();
  const mint = useMintOwnAccessTokenMutation();
  const revoke = useRevokeOwnAccessTokenMutation();
  if (isStationAccessUnavailable(tokens.error)) return null;
  if (tokens.isPending) return null;
  return (
    <section
      className="people__own"
      aria-labelledby="own-access-tokens-heading"
    >
      <h4 className="people__subheading" id="own-access-tokens-heading">
        Your access tokens
      </h4>
      <p className="people__meta">
        A token lets a script or integration act as you. It carries only the
        access you choose, never more than this device has, and stops working
        when you revoke it.
      </p>
      {tokens.isError ? (
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
      ) : (
        <PersonalTokens
          tokens={tokens.data}
          ownerLabel="you"
          mint={(input) => mint.mutateAsync(input)}
          revoke={(token) => revoke.mutateAsync(token.id)}
        />
      )}
    </section>
  );
}
