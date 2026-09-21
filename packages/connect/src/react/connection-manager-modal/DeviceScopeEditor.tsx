import {
  PAIRING_SCOPE_ACCESS_APPROVE,
  PAIRING_SCOPE_ACCESS_MANAGE,
  PAIRING_SCOPE_CONSENT_DECIDE,
  PAIRING_SCOPE_ENGINE_LOGIN,
  PAIRING_SCOPE_HOME_CONTROL,
  PAIRING_SCOPE_HOME_TRANSFER,
  PAIRING_SCOPE_PRESETS,
  type PairingScope,
  type PairingScopePreset,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import { useState } from 'react';

/**
 * Inline editor for a paired device's access (station#3816).
 *
 * A device's scope was fixed at pairing time; the only mutation was revoking
 * the whole device. So narrowing a phone from Standard to Read-only meant
 * unpairing it — losing its identity and history — which quietly pushes
 * people to over-grant at pairing time, because the alternative is worse.
 *
 * Shape of the control, and why:
 *
 *  - The BASE level reuses the pairing-time preset vocabulary (Read-only /
 *    Delegation / Standard), because that is the choice the person already
 *    made once and understands. No new taxonomy to learn for an edit.
 *  - The ELEVATED grants — home control, approving pairing requests, deciding
 *    consent, and starting an engine sign-in — are separate switches, not
 *    presets, because that is what they are in the contracts:
 *    `operator-promotion` tokens, in no preset, granted deliberately to an
 *    already-paired device. The switch plus Apply is the same
 *    two-deliberate-acts weight the revoke control carries. Every
 *    `operator-promotion` token must appear in this list, and a test enforces
 *    it: the list is hand-written, the contracts vocabulary grows on its own,
 *    and the two drifted the first time it did.
 *  - Narrowing and widening use the same editor. The asymmetry lives in the
 *    copy, not in friction: widening is labelled as elevated where it is
 *    offered, rather than interrogated after being chosen.
 *
 * Inline rather than a modal, matching the revoke confirm in this family —
 * and `window.confirm` is ruled out repo-wide.
 */

const BASE_PRESETS: ReadonlyArray<{
  preset: PairingScopePreset;
  label: string;
  detail: string;
}> = [
  {
    preset: 'read-only',
    label: 'Read-only',
    detail: 'Can view and stream state. Cannot change anything.',
  },
  {
    preset: 'delegation',
    label: 'Delegation',
    detail: 'Can read and operate. No terminal.',
  },
  {
    preset: 'standard',
    label: 'Standard',
    detail: 'Can read, operate, and open a terminal.',
  },
];

/**
 * #488 invited-admin slice: the base choice an operator approves for a
 * collaborator's account-bound browser. It grants exactly the delegation
 * token set (`orchestration:read` + `orchestration:operate`) — the device
 * half of invited-admin management — and deliberately nothing else: no
 * terminal, no device management, never the standard personal preset. The
 * grant alone confers no Project membership; the person must separately be
 * a Project admin, and joining a Project never escalates this grant.
 */
export const COLLABORATOR_MANAGEMENT_CHOICE =
  'collaborator-management' as const;
export type ScopeBaseChoice =
  | PairingScopePreset
  | typeof COLLABORATOR_MANAGEMENT_CHOICE;
const COLLABORATOR_MANAGEMENT_OPTION = {
  choice: COLLABORATOR_MANAGEMENT_CHOICE,
  label: 'Collaborator management',
  detail:
    'Exactly read and operate for an account-bound collaborator’s browser. Selecting this clears any capabilities ticked below — they take no effect with this choice. To combine read and operate with a capability, choose Delegation instead. Project people and invitation management become available only on Projects shared with that person as an admin. No terminal, no device management.',
} as const;

/**
 * The base ladder covers ORCHESTRATION access only, and `none` is a real
 * rung: a fleet-inference node holds no orchestration tokens at all.
 * Modelling inference as a base rung instead (the first attempt) made valid
 * MIXED scopes unrepresentable — the server composes `inference:invoke`
 * freely with the ladder, so `orchestration:read inference:invoke` would
 * have initialised as Read-only and silently dropped inference on Apply
 * (review). Capabilities compose; bases exclude. Each token belongs to
 * whichever of those two shapes it actually has.
 */
const NO_BASE_OPTION = {
  preset: null,
  label: 'No work access',
  detail: 'Cannot read or operate. Use with a capability below.',
} as const;

const ELEVATED_GRANTS: ReadonlyArray<{
  token: PairingScope;
  label: string;
  detail: string;
  elevated: boolean;
}> = [
  {
    token: 'inference:invoke' as PairingScope,
    label: 'Fleet inference',
    detail: 'Can request model completions from this Station.',
    // Not elevated: it is a `preset` grant path, offered at pairing time.
    elevated: false,
  },
  {
    token: PAIRING_SCOPE_HOME_TRANSFER,
    label: 'Home transfer',
    detail:
      'Identifies this device for transfer setup. Moving homes and resuming agents are not available yet.',
    // This is a dedicated pairing preset, not an operator-promotion grant.
    elevated: false,
  },
  {
    token: PAIRING_SCOPE_HOME_CONTROL,
    label: 'Home control',
    detail:
      'Allows home-control sessions. Room access and Agent execution still require their own permissions.',
    elevated: true,
  },
  {
    token: PAIRING_SCOPE_ACCESS_APPROVE,
    label: 'Approve pairing requests',
    detail: 'Can approve or deny other devices asking to pair.',
    elevated: true,
  },
  {
    token: PAIRING_SCOPE_CONSENT_DECIDE,
    label: 'Decide consent requests',
    detail: 'Can approve or deny consent requests on the consent page.',
    elevated: true,
  },
  {
    token: PAIRING_SCOPE_ENGINE_LOGIN,
    label: 'Start engine sign-in',
    detail:
      "Can start an engine's own device-code sign-in on this Station and see the code to approve. The engine stores the account in this Station's credential profile, so agents using that profile run as it; Station never sees the token.",
    elevated: true,
  },
];

/** The closest base preset to an existing scope, for initialising the form. */
export function closestBasePreset(scope: string): PairingScopePreset | null {
  const tokens = new Set(parsePairingScope(scope) ?? []);
  const covers = (preset: PairingScopePreset) =>
    PAIRING_SCOPE_PRESETS[preset].every((token) => tokens.has(token));
  if (covers('standard')) return 'standard';
  if (covers('delegation')) return 'delegation';
  if (covers('read-only')) return 'read-only';
  // No orchestration access at all — a fleet-inference node, or an
  // unparseable legacy scope. Either way the narrowest answer is the honest
  // one: initialising generously would make the first Apply a silent
  // widening.
  return null;
}

/** The tokens the editor's current selection resolves to. */
export function scopeSelectionTokens(
  preset: PairingScopePreset | null,
  capabilities: ReadonlySet<PairingScope>,
): PairingScope[] {
  return scopeChoiceTokens(preset, capabilities);
}

/** True when the scope holds exactly the delegation token set, no more. */
function isExactDelegationScope(scope: string): boolean {
  const tokens = parsePairingScope(scope) ?? [];
  return (
    tokens.length === PAIRING_SCOPE_PRESETS.delegation.length &&
    PAIRING_SCOPE_PRESETS.delegation.every((token) => tokens.includes(token))
  );
}

/**
 * The tokens the editor's current selection resolves to, including the
 * collaborator-management choice: exactly the delegation token set, full
 * stop — ticked capabilities take no effect with this choice (the UI
 * clears and disables them while it is selected, so this ignore is
 * unreachable from the form and exists only as enforcement). Every other
 * choice keeps the ordinary behavior: base plus explicitly ticked
 * capabilities. Never terminal, never device management, never the
 * standard preset's extras.
 */
export function scopeChoiceTokens(
  choice: ScopeBaseChoice | null,
  capabilities: ReadonlySet<PairingScope>,
): PairingScope[] {
  if (choice === COLLABORATOR_MANAGEMENT_CHOICE)
    return [...PAIRING_SCOPE_PRESETS.delegation];
  const base = choice ? PAIRING_SCOPE_PRESETS[choice] : [];
  return [
    ...base,
    ...ELEVATED_GRANTS.map(({ token }) => token).filter((token) =>
      capabilities.has(token),
    ),
  ];
}

export function DeviceScopeEditor({
  deviceName,
  currentScope,
  busy,
  accountBound = false,
  onApply,
  onCancel,
}: {
  deviceName: string;
  currentScope: string;
  busy: boolean;
  /**
   * Whether the device carries an account binding (an account-bound
   * collaborator browser rather than a personal or peer device). Only with
   * a binding does an exact read+operate grant reopen as the
   * collaborator-management choice it was approved under — without one the
   * same tokens stay Delegation, so the two choices never read as
   * duplicates. This names the device's stored binding, never membership.
   */
  accountBound?: boolean;
  /** `expectedScope` is what this editor was opened against (station#3816). */
  onApply: (scope: PairingScope[], expectedScope: string) => void;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState<ScopeBaseChoice | null>(() =>
    accountBound && isExactDelegationScope(currentScope)
      ? COLLABORATOR_MANAGEMENT_CHOICE
      : closestBasePreset(currentScope),
  );
  const [elevated, setElevated] = useState<ReadonlySet<PairingScope>>(() => {
    const tokens = new Set(parsePairingScope(currentScope) ?? []);
    return new Set(
      ELEVATED_GRANTS.map(({ token }) => token).filter((token) =>
        tokens.has(token),
      ),
    );
  });

  // A default-grant device (migrated / scope-omitting / continuity) carries
  // `access:manage`, which has NO promotion path: the server refuses to
  // re-grant it, deliberately. So the first edit of such a device drops it
  // permanently. That must be said BEFORE Apply, not discovered after.
  const dropsDeviceManagement = (
    parsePairingScope(currentScope) ?? []
  ).includes(PAIRING_SCOPE_ACCESS_MANAGE);

  return (
    <div className="station-connect-scope-editor">
      <div
        className="station-connect-scope-editor__group"
        role="radiogroup"
        aria-label={`Access level for ${deviceName}`}
      >
        {[
          ...BASE_PRESETS.map(({ preset: option, label, detail }) => ({
            option: option as ScopeBaseChoice | null,
            label,
            detail,
          })),
          {
            option:
              COLLABORATOR_MANAGEMENT_OPTION.choice as ScopeBaseChoice | null,
            label: COLLABORATOR_MANAGEMENT_OPTION.label,
            detail: COLLABORATOR_MANAGEMENT_OPTION.detail,
          },
          {
            option: NO_BASE_OPTION.preset as ScopeBaseChoice | null,
            label: NO_BASE_OPTION.label,
            detail: NO_BASE_OPTION.detail,
          },
        ].map(({ option, label, detail }) => (
          <label
            className="station-connect-scope-editor__option"
            key={option ?? 'none'}
          >
            <input
              type="radio"
              name={`scope-${deviceName}`}
              checked={choice === option}
              disabled={busy}
              onChange={() => {
                setChoice(option);
                // The collaborator choice grants exactly read+operate, so
                // previously ticked capabilities must go visibly — leaving
                // them checked while claiming a narrow grant would lie.
                if (option === COLLABORATOR_MANAGEMENT_CHOICE)
                  setElevated(new Set());
              }}
            />
            <span>
              <strong>{label}</strong>
              <span className="station-connect-scope-editor__detail">
                {detail}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="station-connect-scope-editor__group">
        <div className="station-connect-scope-editor__elevated-header">
          Also allowed
        </div>
        {choice === COLLABORATOR_MANAGEMENT_CHOICE && (
          <p className="station-connect-scope-editor__notice">
            Collaborator management grants exactly read and operate —
            capabilities take no effect with this choice. Choose Delegation to
            combine read and operate with a capability below.
          </p>
        )}
        {ELEVATED_GRANTS.map(
          ({ token, label, detail, elevated: isElevated }) => (
            <label className="station-connect-scope-editor__option" key={token}>
              <input
                type="checkbox"
                checked={elevated.has(token)}
                disabled={busy || choice === COLLABORATOR_MANAGEMENT_CHOICE}
                onChange={(event) => {
                  setElevated((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(token);
                    else next.delete(token);
                    return next;
                  });
                }}
              />
              <span>
                <strong>{label}</strong>
                {isElevated && (
                  <span className="station-connect-scope-editor__elevated-tag">
                    Elevated
                  </span>
                )}
                <span className="station-connect-scope-editor__detail">
                  {detail}
                </span>
              </span>
            </label>
          ),
        )}
      </div>

      {dropsDeviceManagement && (
        <p className="station-connect-scope-editor__notice">
          {/* The first version called this "device management access", which
              is wrong: a paired device is refused the pairing family
              regardless. What access:manage actually gates is a different
              set of sensitive surfaces, and the notice has to name them or
              it is asking for a decision the reader cannot make (review). */}
          This device inherited extra access from an earlier Station version —
          telemetry disclosure, fleet receipts, share management, unattended
          grants, peer credentials, and credential recovery. Changing its access
          removes that permanently: there is no way to grant it back.
        </p>
      )}

      <div className="station-connect-row__actions station-connect-row__actions--static">
        <button
          type="button"
          // An empty scope is not a valid grant and the server refuses it.
          // Saying so by disabling the control is better than letting
          // someone submit a change that cannot mean anything; revoking is
          // the control for "no access at all", and it is right there.
          disabled={busy || scopeChoiceTokens(choice, elevated).length === 0}
          onClick={() =>
            onApply(scopeChoiceTokens(choice, elevated), currentScope)
          }
          className="station-connect-btn station-connect-btn--inline"
        >
          Apply
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="station-connect-btn station-connect-btn--secondary station-connect-btn--inline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
