import {
  PAIRING_SCOPE_ACCESS_APPROVE,
  PAIRING_SCOPE_ACCESS_MANAGE,
  PAIRING_SCOPE_CONSENT_DECIDE,
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
 *  - The two ELEVATED grants — approving pairing requests and deciding
 *    consent — are separate switches, not presets, because that is what they
 *    are in the contracts: `operator-promotion` tokens, in no preset,
 *    granted deliberately to an already-paired device. The switch plus Apply
 *    is the same two-deliberate-acts weight the revoke control carries.
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
  return [
    ...(preset ? PAIRING_SCOPE_PRESETS[preset] : []),
    ...ELEVATED_GRANTS.map(({ token }) => token).filter((token) =>
      capabilities.has(token),
    ),
  ];
}

export function DeviceScopeEditor({
  deviceName,
  currentScope,
  busy,
  onApply,
  onCancel,
}: {
  deviceName: string;
  currentScope: string;
  busy: boolean;
  /** `expectedScope` is what this editor was opened against (station#3816). */
  onApply: (scope: PairingScope[], expectedScope: string) => void;
  onCancel: () => void;
}) {
  const [preset, setPreset] = useState<PairingScopePreset | null>(() =>
    closestBasePreset(currentScope),
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
        {[...BASE_PRESETS, NO_BASE_OPTION].map(
          ({ preset: option, label, detail }) => (
            <label
              className="station-connect-scope-editor__option"
              key={option ?? 'none'}
            >
              <input
                type="radio"
                name={`scope-${deviceName}`}
                checked={preset === option}
                disabled={busy}
                onChange={() => setPreset(option)}
              />
              <span>
                <strong>{label}</strong>
                <span className="station-connect-scope-editor__detail">
                  {detail}
                </span>
              </span>
            </label>
          ),
        )}
      </div>

      <div className="station-connect-scope-editor__group">
        <div className="station-connect-scope-editor__elevated-header">
          Also allowed
        </div>
        {ELEVATED_GRANTS.map(
          ({ token, label, detail, elevated: isElevated }) => (
            <label className="station-connect-scope-editor__option" key={token}>
              <input
                type="checkbox"
                checked={elevated.has(token)}
                disabled={busy}
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
          disabled={busy || scopeSelectionTokens(preset, elevated).length === 0}
          onClick={() =>
            onApply(scopeSelectionTokens(preset, elevated), currentScope)
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
