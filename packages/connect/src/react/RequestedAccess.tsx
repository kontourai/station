import './RequestedAccess.css';
import {
  DEVICE_REQUESTABLE_EXTRA_SCOPES,
  PAIRING_SCOPE_DESCRIPTIONS,
  PAIRING_SCOPE_PRESETS,
  PAIRING_SCOPES,
  type PairingScope,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import { useState } from 'react';

const REQUESTABLE_EXTRAS: readonly PairingScope[] =
  DEVICE_REQUESTABLE_EXTRA_SCOPES;

/**
 * Everything a paired device can be given: Standard plus the elevated
 * permissions a device may ask for. The Station app and browser ask for this;
 * scoping a device down is the exception, done when approving.
 */
export const FULL_DEVICE_ACCESS_SCOPE = PAIRING_SCOPES.filter((token) =>
  [...PAIRING_SCOPE_PRESETS.standard, ...REQUESTABLE_EXTRAS].includes(token),
).join(' ');

/** The tokens of a requested scope, in the vocabulary's order. */
export function requestedScopeTokens(scope: string): PairingScope[] {
  const tokens = new Set(parsePairingScope(scope) ?? []);
  return PAIRING_SCOPES.filter((token) => tokens.has(token));
}

/** What an approval keeps before the approver limits it: all of the request. */
export function defaultKeptScope(scope: string): Set<PairingScope> {
  return new Set(requestedScopeTokens(scope));
}

/**
 * The scope to send with an approval: `undefined` when everything requested
 * is kept (the route's bodyless approval), otherwise the kept tokens.
 */
export function keptScopeForApproval(
  requestedScope: string,
  kept: ReadonlySet<PairingScope>,
): string | undefined {
  const requested = requestedScopeTokens(requestedScope);
  const keptTokens = requested.filter((token) => kept.has(token));
  return keptTokens.length === requested.length
    ? undefined
    : keptTokens.join(' ');
}

/**
 * The grant in a few words: "full device access" when it is exactly what the
 * Station app asks for, otherwise every permission by name, so nothing a
 * broader request carries (an operator offer's `access:manage`, say) hides
 * behind the phrase.
 */
export function describeDeviceGrant(tokens: Iterable<PairingScope>): string {
  const given = new Set(tokens);
  const granted = PAIRING_SCOPES.filter((token) => given.has(token));
  const full = requestedScopeTokens(FULL_DEVICE_ACCESS_SCOPE);
  if (
    granted.length === full.length &&
    full.every((token) => granted.includes(token))
  )
    return 'full device access';
  return granted
    .map((token) => PAIRING_SCOPE_DESCRIPTIONS[token].label)
    .join(', ');
}

/** The elevated permissions a kept set includes, by label. */
export function elevatedLabels(kept: ReadonlySet<PairingScope>): string[] {
  return REQUESTABLE_EXTRAS.filter((token) => kept.has(token)).map(
    (token) => PAIRING_SCOPE_DESCRIPTIONS[token].label,
  );
}

/**
 * What a pending request asks for, said in one line, with the permissions in
 * a collapsed "Limit access" list. Approving keeps all of it unless the
 * approver unticks something there; at least one permission must stay.
 */
export function RequestedScopeChecklist({
  deviceName,
  requestedScope,
  kept,
  onChange,
  disabled = false,
}: {
  deviceName: string;
  requestedScope: string;
  kept: ReadonlySet<PairingScope>;
  onChange: (next: Set<PairingScope>) => void;
  disabled?: boolean;
}) {
  const tokens = requestedScopeTokens(requestedScope);
  const limited = kept.size < tokens.length;
  // Opened by the person, or already limited when shown; never closed under
  // them because a tick changed whether it is limited.
  const [open, setOpen] = useState(limited);
  if (tokens.length === 0) return null;
  return (
    <div className="requested-access">
      <p className="requested-access__summary">
        {deviceName} asks for <strong>{describeDeviceGrant(tokens)}</strong>.
        {limited && (
          <>
            {' '}
            Approving grants only <strong>{describeDeviceGrant(kept)}</strong>.
          </>
        )}
      </p>
      <details
        className="requested-access__limit"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>Limit access</summary>
        <fieldset
          className="requested-access__list"
          disabled={disabled}
          aria-label={`What ${deviceName} may do`}
        >
          {tokens.map((token) => {
            const isOnlyKept = kept.has(token) && kept.size === 1;
            return (
              <label key={token} className="requested-access__option">
                <input
                  type="checkbox"
                  checked={kept.has(token)}
                  disabled={isOnlyKept}
                  onChange={(event) => {
                    const next = new Set(kept);
                    if (event.target.checked) next.add(token);
                    else next.delete(token);
                    onChange(next);
                  }}
                />
                <span>
                  {PAIRING_SCOPE_DESCRIPTIONS[token].label}
                  {REQUESTABLE_EXTRAS.includes(token) && (
                    <span className="requested-access__tag">Elevated</span>
                  )}
                  <span className="requested-access__detail">
                    {PAIRING_SCOPE_DESCRIPTIONS[token].summary}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      </details>
    </div>
  );
}
