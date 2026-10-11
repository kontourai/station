import {
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import {
  MAX_PERSONAL_TOKENS_PER_PERSON,
  type MintedPersonalAccessToken,
  type PersonalAccessToken,
} from '@kontourai/station-contracts/personal-tokens';
import {
  isOperatorCredentialRequired,
  type PersonalTokenInput,
  StationAccessError,
} from '@kontourai/station-sdk';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { copyToClipboard } from '../../lib/clipboard';
import { userFacingErrorMessage } from '../../utils/errorText';
import { relativeTimeAgo } from '../../utils/relativeTime';
import './PeopleSection.css';

/**
 * #3557: one person's personal access tokens — the list, Revoke, and the New
 * token form whose answer shows the secret exactly once. The operator's
 * People page and a person's own "Your access tokens" panel render the same
 * component over their own routes, so the two cannot drift apart.
 */

const READ_SCOPE = PAIRING_SCOPE_ORCHESTRATION_READ;
const OPERATE_SCOPE = `${PAIRING_SCOPE_ORCHESTRATION_READ} ${PAIRING_SCOPE_ORCHESTRATION_OPERATE}`;

const ACCESS_CHOICES = [
  {
    scope: READ_SCOPE,
    label: 'Read',
    detail: 'View chats, sessions and work.',
  },
  {
    scope: OPERATE_SCOPE,
    label: 'Read & operate',
    detail: 'Also start, continue and steer work.',
  },
] as const;

const EXPIRY_CHOICES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
] as const;

/** The access a token scope gives, in the form's own words. */
export function tokenAccessLabel(scope: string): string {
  return parsePairingScope(scope)?.includes(PAIRING_SCOPE_ORCHESTRATION_OPERATE)
    ? 'Read & operate'
    : 'Read';
}

/** Whether two scopes grant the same permissions, whatever their order. */
export function sameScope(left: string, right: string): boolean {
  const a = new Set(parsePairingScope(left) ?? left.split(' '));
  const b = new Set(parsePairingScope(right) ?? right.split(' '));
  return a.size === b.size && [...a].every((token) => b.has(token));
}

/** The guidance for a refused People change made without the operator credential. */
export const OPERATOR_CREDENTIAL_REQUIRED_MESSAGE =
  'Changing groups and tokens needs this Station’s operator credential, which this app doesn’t hold — it can only view them. Make the change from a connection that uses the operator credential.';

/** A refused token action, said as what to do next. */
export function tokenActionMessage(error: unknown): string {
  if (isOperatorCredentialRequired(error))
    return OPERATOR_CREDENTIAL_REQUIRED_MESSAGE;
  if (error instanceof StationAccessError) {
    switch (error.code) {
      case 'token_limit_reached':
        return `A person can hold ${MAX_PERSONAL_TOKENS_PER_PERSON} active tokens. Revoke one, then try again.`;
      case 'scope_exceeds_access':
        return 'This device can’t give a token more access than it has. Choose Read, then try again.';
      case 'insufficient_scope':
        return 'This device’s access doesn’t allow managing tokens.';
      case 'account_bound_person':
        return 'Tokens work only for a person tied by a Tailscale identity. A device tied by an account needs its sign-in session, which a script doesn’t have.';
      case 'tokens_unavailable':
        return 'Tokens can’t be changed on this Station right now. Try again in a moment.';
      case 'person_not_found':
        return 'This person has no device tied to them any more, so a token can’t be made for them.';
      case 'not_found':
        return 'That token no longer exists. It may already have been revoked.';
      case 'invalid_request':
        return 'Station didn’t accept that token. Check its name, access and expiry, then try again.';
    }
  }
  return userFacingErrorMessage(error);
}

function expiryText(token: PersonalAccessToken, now: number): string {
  if (token.expiresAt === null) return 'Never expires';
  const date = new Date(token.expiresAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return token.expiresAt <= now ? `Expired ${date}` : `Expires ${date}`;
}

function TokenRow({
  token,
  limitedBy,
  busy,
  onRevoke,
}: {
  token: PersonalAccessToken;
  limitedBy?: string;
  busy: boolean;
  onRevoke: () => void;
}) {
  const now = Date.now();
  const limited = !sameScope(token.scope, token.effectiveScope);
  return (
    <li className="people__item">
      <div className="people__item-text">
        <span className="people__item-name">{token.name}</span>
        <span className="people__meta">
          {tokenAccessLabel(token.scope)} · {expiryText(token, now)} ·{' '}
          {token.lastUsedAt === null
            ? 'Never used'
            : `Last used ${relativeTimeAgo(token.lastUsedAt, now)}`}
        </span>
        {limited && limitedBy && (
          <span className="people__limited">
            Limited to {tokenAccessLabel(token.effectiveScope)} by the{' '}
            {limitedBy} group
          </span>
        )}
      </div>
      <Button
        size="sm"
        variant="danger-outline"
        disabled={busy}
        onClick={onRevoke}
        aria-label={`Revoke token ${token.name}`}
      >
        Revoke
      </Button>
    </li>
  );
}

/** The secret, once. Leaving this box (Done) is the last time it exists here. */
function SecretOnce({
  minted,
  onDone,
}: {
  minted: MintedPersonalAccessToken;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const fieldId = useId();
  return (
    <div className="people__secret" role="status">
      <label className="people__secret-label" htmlFor={fieldId}>
        New token “{minted.token.name}”
      </label>
      <p className="people__secret-warning">
        Copy it now — it won’t be shown again.
      </p>
      <div className="people__secret-row">
        <input
          id={fieldId}
          className="people__secret-value"
          readOnly
          value={minted.secret}
          onFocus={(event) => event.currentTarget.select()}
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          size="sm"
          onClick={() => {
            void copyToClipboard(minted.secret).then(setCopied);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {copied === false && (
        <p className="people__meta" role="alert">
          Couldn’t copy automatically. Select the token and copy it yourself.
        </p>
      )}
      <p className="people__meta">
        Send it as <code>Authorization: Bearer …</code>.
      </p>
      <div className="people__actions">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function NewTokenForm({
  ownerLabel,
  pending,
  onCancel,
  onSubmit,
}: {
  ownerLabel: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (input: PersonalTokenInput) => void;
}) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>(READ_SCOPE);
  const [expiry, setExpiry] = useState<string>('90');
  const nameId = useId();
  const expiryId = useId();
  const trimmed = name.trim();
  return (
    <form
      className="people__form"
      aria-label={`New token for ${ownerLabel}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed) return;
        onSubmit({
          name: trimmed,
          scope,
          ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }),
        });
      }}
    >
      <label className="people__field" htmlFor={nameId}>
        <span className="people__field-label">Name</span>
        <input
          id={nameId}
          className="people__input"
          value={name}
          maxLength={100}
          placeholder="e.g. Release script"
          onChange={(event) => setName(event.target.value)}
          disabled={pending}
          required
        />
      </label>
      <fieldset className="people__field people__choices" disabled={pending}>
        <legend className="people__field-label">Access</legend>
        {ACCESS_CHOICES.map((choice) => (
          <label key={choice.scope} className="people__choice">
            <input
              type="radio"
              name={`${nameId}-access`}
              checked={scope === choice.scope}
              onChange={() => setScope(choice.scope)}
            />
            <span>
              {choice.label}
              <span className="people__meta">{choice.detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="people__field" htmlFor={expiryId}>
        <span className="people__field-label">Expires after</span>
        <select
          id={expiryId}
          className="editor-select"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          disabled={pending}
        >
          {EXPIRY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <div className="people__actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!trimmed}
          pending={pending}
          pendingLabel="Creating…"
        >
          Create token
        </Button>
        <Button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The token list and its actions. `mint` and `revoke` are the caller's own
 * route family; their refusals are rendered here, never swallowed.
 */
export function PersonalTokens({
  tokens,
  ownerLabel,
  limitedBy,
  canMint = true,
  cannotMintReason,
  mint,
  revoke,
}: {
  tokens: readonly PersonalAccessToken[];
  /** Whose tokens these are, for accessible names ("Ada", "you"). */
  ownerLabel: string;
  /** The owner's group label, to say when it limits a token. */
  limitedBy?: string;
  canMint?: boolean;
  cannotMintReason?: string;
  mint: (input: PersonalTokenInput) => Promise<MintedPersonalAccessToken>;
  revoke: (token: PersonalAccessToken) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [minting, setMinting] = useState(false);
  // The secret lives in this state and nowhere else on the client: the
  // mutation evicts its settled answer, and Done drops this.
  const [minted, setMinted] = useState<MintedPersonalAccessToken | null>(null);
  const [pendingRevoke, setPendingRevoke] =
    useState<PersonalAccessToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function submit(input: PersonalTokenInput) {
    setError(null);
    setMinting(true);
    try {
      setMinted(await mint(input));
      setCreating(false);
    } catch (cause) {
      setError(tokenActionMessage(cause));
    } finally {
      setMinting(false);
    }
  }

  async function confirmRevoke() {
    if (!pendingRevoke) return;
    setRevokeError(null);
    setRevoking(true);
    try {
      await revoke(pendingRevoke);
      setPendingRevoke(null);
    } catch (cause) {
      setRevokeError(tokenActionMessage(cause));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="people__tokens">
      {tokens.length === 0 ? (
        <p className="people__meta">No tokens.</p>
      ) : (
        <ul className="people__list" aria-label={`Tokens for ${ownerLabel}`}>
          {tokens.map((token) => (
            <TokenRow
              key={token.id}
              token={token}
              {...(limitedBy ? { limitedBy } : {})}
              busy={revoking}
              onRevoke={() => {
                setRevokeError(null);
                setPendingRevoke(token);
              }}
            />
          ))}
        </ul>
      )}
      {minted ? (
        <SecretOnce minted={minted} onDone={() => setMinted(null)} />
      ) : creating ? (
        <NewTokenForm
          ownerLabel={ownerLabel}
          pending={minting}
          onCancel={() => {
            setCreating(false);
            setError(null);
          }}
          onSubmit={(input) => void submit(input)}
        />
      ) : canMint ? (
        <div className="people__actions">
          <Button size="sm" onClick={() => setCreating(true)}>
            New token
          </Button>
        </div>
      ) : cannotMintReason ? (
        <p className="people__meta">{cannotMintReason}</p>
      ) : null}
      {error && (
        <p className="people__error" role="alert">
          {error}
        </p>
      )}
      <ConfirmModal
        isOpen={pendingRevoke !== null}
        title={`Revoke token “${pendingRevoke?.name ?? ''}”?`}
        message="Anything using it stops working immediately. This can’t be undone."
        confirmLabel="Revoke"
        variant="danger"
        role="alertdialog"
        pending={revoking}
        error={revokeError}
        onConfirm={() => void confirmRevoke()}
        onCancel={() => {
          setPendingRevoke(null);
          setRevokeError(null);
        }}
      />
    </div>
  );
}
