import './RequestedAccess.css';
import {
  DEVICE_REQUESTABLE_BASE_PRESETS,
  DEVICE_REQUESTABLE_EXTRA_SCOPES,
  PAIRING_SCOPE_DESCRIPTIONS,
  PAIRING_SCOPE_PRESETS,
  PAIRING_SCOPES,
  type PairingScope,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';

type RequestableBase = (typeof DEVICE_REQUESTABLE_BASE_PRESETS)[number];
type RequestableExtra = (typeof DEVICE_REQUESTABLE_EXTRA_SCOPES)[number];

/** What a device asks for: one base and any requestable extras. */
export interface RequestedAccessChoice {
  base: RequestableBase;
  extras: ReadonlySet<RequestableExtra>;
}

export const DEFAULT_REQUESTED_ACCESS: RequestedAccessChoice = {
  base: 'standard',
  extras: new Set(),
};

const BASE_COPY: Record<RequestableBase, { label: string; detail: string }> = {
  'read-only': {
    label: 'Read-only',
    detail: 'View and follow work. Cannot change anything.',
  },
  standard: {
    label: 'Standard',
    detail: 'Read, operate, and open a terminal.',
  },
};

/** The scope string a choice asks for, in the vocabulary's order. */
export function requestedAccessScope(choice: RequestedAccessChoice): string {
  const tokens = new Set<PairingScope>([
    ...PAIRING_SCOPE_PRESETS[choice.base],
    ...choice.extras,
  ]);
  return PAIRING_SCOPES.filter((token) => tokens.has(token)).join(' ');
}

/**
 * The requester's permission list: Standard pre-selected, Read-only instead,
 * and the elevated extras a device may ask for. The operator sees the same
 * list when approving and can untick any of it.
 */
export function RequestAccessPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: RequestedAccessChoice;
  onChange: (next: RequestedAccessChoice) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="requested-access" disabled={disabled}>
      <legend className="requested-access__legend">Ask for</legend>
      <div role="radiogroup" aria-label="Access level">
        {DEVICE_REQUESTABLE_BASE_PRESETS.map((base) => (
          <label key={base} className="requested-access__option">
            <input
              type="radio"
              name="requested-access-base"
              checked={value.base === base}
              onChange={() => onChange({ ...value, base })}
            />
            <span>
              {BASE_COPY[base].label}
              <span className="requested-access__detail">
                {BASE_COPY[base].detail}
              </span>
            </span>
          </label>
        ))}
      </div>
      <span className="requested-access__group-header">
        Also ask for (the operator decides on these)
      </span>
      {DEVICE_REQUESTABLE_EXTRA_SCOPES.map((token) => (
        <label key={token} className="requested-access__option">
          <input
            type="checkbox"
            checked={value.extras.has(token)}
            onChange={(event) => {
              const extras = new Set(value.extras);
              if (event.target.checked) extras.add(token);
              else extras.delete(token);
              onChange({ ...value, extras });
            }}
          />
          <span>
            {PAIRING_SCOPE_DESCRIPTIONS[token].label}
            <span className="requested-access__tag">Elevated</span>
            <span className="requested-access__detail">
              {PAIRING_SCOPE_DESCRIPTIONS[token].summary}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** The tokens of a requested scope, in the vocabulary's order. */
export function requestedScopeTokens(scope: string): PairingScope[] {
  const tokens = new Set(parsePairingScope(scope) ?? []);
  return PAIRING_SCOPES.filter((token) => tokens.has(token));
}

const REQUESTABLE_EXTRAS: readonly PairingScope[] =
  DEVICE_REQUESTABLE_EXTRA_SCOPES;

/**
 * What an approval keeps before the approver touches the list: everything
 * requested except the elevated extras. Keeping full access or running
 * commands is an explicit tick, never a reflexive Approve.
 */
export function defaultKeptScope(scope: string): Set<PairingScope> {
  return new Set(
    requestedScopeTokens(scope).filter(
      (token) => !REQUESTABLE_EXTRAS.includes(token),
    ),
  );
}

/** Whether a kept set still includes an elevated extra. */
export function keepsElevatedScope(kept: ReadonlySet<PairingScope>): boolean {
  return REQUESTABLE_EXTRAS.some((token) => kept.has(token));
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
 * What a pending request asks for, one line per permission. The ordinary
 * ones start ticked and the elevated extras start unticked (see
 * {@link defaultKeptScope}); the approver changes either, keeping at least
 * one.
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
  if (tokens.length === 0) return null;
  return (
    <fieldset className="requested-access" disabled={disabled}>
      <legend className="requested-access__legend">
        {deviceName} asks for
      </legend>
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
                <span className="requested-access__tag">
                  Elevated · tick to grant
                </span>
              )}
              <span className="requested-access__detail">
                {PAIRING_SCOPE_DESCRIPTIONS[token].summary}
              </span>
            </span>
          </label>
        );
      })}
      {kept.size < tokens.length && (
        <p className="requested-access__note">
          Approving grants only what is ticked.
        </p>
      )}
    </fieldset>
  );
}
