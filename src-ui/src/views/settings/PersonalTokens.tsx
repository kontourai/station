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
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { Empty } from '../../components/state';
import { copyToClipboard } from '../../lib/clipboard';
import { userFacingErrorMessage } from '../../utils/errorText';
import { relativeTimeAgo } from '../../utils/relativeTime';
import './PeopleSection.css';

/**
 * #3557: one person's personal access tokens — the list, Revoke, and the New
 * token form. The operator's People section and a person's own "Your access
 * tokens" panel render the same component over their own routes, so the two
 * cannot drift apart.
 *
 * The minted secret is NOT held here. The caller keeps it above its own list
 * query, because a refetch that fails (or is refused) after a mint can stop
 * this component rendering — and the secret exists nowhere else. The caller
 * also resets the mint mutation once it has captured the answer, so the
 * secret is not left in the mutation cache either.
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
function tokenAccessLabel(scope: string): string {
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
function tokenActionMessage(error: unknown): string {
  if (isOperatorCredentialRequired(error))
    return OPERATOR_CREDENTIAL_REQUIRED_MESSAGE;
  if (error instanceof StationAccessError) {
    switch (error.code) {
      case 'token_limit_reached':
        return `A person can hold ${MAX_PERSONAL_TOKENS_PER_PERSON} active tokens. Revoke one, then try again.`;
      case 'scope_exceeds_access':
        return 'A token can’t carry more access than this device has.';
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
    <li className="people__row">
      <div className="people__row-text">
        <span className="people__row-name">{token.name}</span>
        <span className="people__meta">
          {tokenAccessLabel(token.scope)} · {expiryText(token, now)} ·{' '}
          {token.lastUsedAt === null
            ? 'Never used'
            : `Last used ${relativeTimeAgo(token.lastUsedAt, now)}`}
        </span>
      </div>
      {limited && limitedBy && (
        <span
          className="people__badge"
          title={`Usable as ${tokenAccessLabel(token.effectiveScope)}`}
        >
          Limited by {limitedBy} group
        </span>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="people__compact people__revoke"
        disabled={busy}
        onClick={onRevoke}
        aria-label={`Revoke token ${token.name}`}
      >
        Revoke
      </Button>
    </li>
  );
}

/**
 * The secret, once. Copy is focused on arrival; only the copy RESULT is
 * announced — the secret itself is never put in a live region.
 */
export function SecretOnce({
  minted,
  ownerLabel,
  onDone,
}: {
  minted: MintedPersonalAccessToken;
  /** Set when the box stands apart from its owner's list. */
  ownerLabel?: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const fieldId = useId();
  const copyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    copyRef.current?.focus();
  }, []);
  return (
    <div className="people__secret" data-testid="token-secret">
      <label className="people__secret-label" htmlFor={fieldId}>
        New token “{minted.token.name}”{ownerLabel ? ` for ${ownerLabel}` : ''}
        <span className="people__secret-warning">
          Copy it now — it won’t be shown again.
        </span>
      </label>
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
        <div className="people__secret-actions">
          <Button
            ref={copyRef}
            size="sm"
            className="people__compact"
            onClick={() => {
              void copyToClipboard(minted.secret).then(setCopied);
            }}
          >
            Copy
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="people__compact"
            onClick={onDone}
          >
            Done
          </Button>
        </div>
      </div>
      <p className="people__meta" role="status">
        {copied === true
          ? 'Copied to the clipboard.'
          : copied === false
            ? 'Couldn’t copy automatically. Select the token and copy it yourself.'
            : ''}
      </p>
      <p className="people__meta">
        Send it as <code>Authorization: Bearer &lt;token&gt;</code>
      </p>
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
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
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
      <div className="people__form-fields">
        <label className="people__field" htmlFor={nameId}>
          <span className="people__field-label">Name</span>
          <input
            ref={nameRef}
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
      </div>
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
      <div className="people__form-actions">
        <Button
          type="button"
          size="sm"
          className="people__compact"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          className="people__compact"
          disabled={!trimmed}
          pending={pending}
          pendingLabel="Creating…"
        >
          Create
        </Button>
      </div>
    </form>
  );
}

/**
 * A token sub-section: its header line (title + a compact "+ New"), the
 * list, and the form or the just-minted secret. `mint` and `revoke` are the
 * caller's own route family; their refusals are rendered here.
 */
export function PersonalTokens({
  heading,
  description,
  tokens,
  ownerLabel,
  limitedBy,
  canMint = true,
  cannotMintReason,
  minted,
  mint,
  onDone,
  revoke,
  onEditingChange,
  newDisabledReason,
}: {
  heading: string;
  /** One muted line under the header. */
  description?: string;
  tokens: readonly PersonalAccessToken[];
  /** Whose tokens these are, for accessible names ("ada@…", "you"). */
  ownerLabel: string;
  /** The owner's group label, to say when it limits a token. */
  limitedBy?: string;
  canMint?: boolean;
  cannotMintReason?: string;
  /** The caller's just-minted token for this owner, until Done. */
  minted: MintedPersonalAccessToken | null;
  /** Mints and hands the answer to the caller, which then passes `minted`. */
  mint: (input: PersonalTokenInput) => Promise<void>;
  onDone: () => void;
  revoke: (token: PersonalAccessToken) => Promise<void>;
  /** Told when the New token form opens or closes, so a caller can keep it shown. */
  onEditingChange?: (editing: boolean) => void;
  /** Set when "+ New" must wait (another token's secret is still showing). */
  newDisabledReason?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [minting, setMinting] = useState(false);
  const [pendingRevoke, setPendingRevoke] =
    useState<PersonalAccessToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  // Busy: a form, a revoke confirmation, or a revoke in flight. A caller
  // keeps this list shown while it is, so none of them unmounts mid-way.
  const busy = creating || pendingRevoke !== null || revoking;
  useEffect(() => {
    onEditingChange?.(busy);
  }, [busy, onEditingChange]);
  const [error, setError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // Leaving the form or the secret returns focus to "+ New".
  const newRef = useRef<HTMLButtonElement>(null);
  const [focusNew, setFocusNew] = useState(false);
  useEffect(() => {
    if (!focusNew || !newRef.current) return;
    newRef.current.focus();
    setFocusNew(false);
  });
  const headingId = useId();
  const waitHintId = useId();

  async function submit(input: PersonalTokenInput) {
    setError(null);
    setMinting(true);
    try {
      await mint(input);
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

  const showNew = canMint && !creating && !minted;
  return (
    <section className="people__sub" aria-labelledby={headingId}>
      <div className="people__sub-header">
        <h5 className="people__sub-title" id={headingId}>
          {heading}
        </h5>
        {showNew && (
          <Button
            ref={newRef}
            size="sm"
            className="people__compact"
            aria-label={`New token for ${ownerLabel}`}
            // Waiting, not disabled: it stays focusable, and its reason is
            // visible text it is described by.
            {...(newDisabledReason
              ? { 'aria-disabled': true, 'aria-describedby': waitHintId }
              : {})}
            onClick={() => {
              if (newDisabledReason) return;
              setError(null);
              setCreating(true);
            }}
          >
            + New
          </Button>
        )}
      </div>
      {description && <p className="people__meta">{description}</p>}
      {showNew && newDisabledReason && (
        <p className="people__meta" id={waitHintId}>
          {newDisabledReason}
        </p>
      )}
      {tokens.length === 0 ? (
        <Empty className="people__none" label="None yet." />
      ) : (
        <ul className="people__rows" aria-label={`Tokens for ${ownerLabel}`}>
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
      {!canMint && cannotMintReason && (
        <p className="people__meta">{cannotMintReason}</p>
      )}
      {minted ? (
        <SecretOnce
          minted={minted}
          onDone={() => {
            onDone();
            setFocusNew(true);
          }}
        />
      ) : creating ? (
        <NewTokenForm
          ownerLabel={ownerLabel}
          pending={minting}
          onCancel={() => {
            setCreating(false);
            setError(null);
            setFocusNew(true);
          }}
          onSubmit={(input) => void submit(input)}
        />
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
    </section>
  );
}
