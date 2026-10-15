/**
 * #3557: Station-wide groups for people. A group is a CEILING on what any
 * credential tied to that person may do: the effective scope of a paired
 * device bound to a person is its granted scope, with every governed
 * permission the person's group does not allow removed.
 *
 * Only the permissions below are governed. Every other pairing scope (fleet
 * inference, home transfer and control, relay and engine sign-in, the
 * historical `access:manage`) keeps its own operator-promotion path and
 * passes through unchanged, so introducing groups never widens anything and
 * never silently removes a grant outside their remit.
 *
 * The operator (Owner) is implicit and never capped, and neither is a
 * device tied to no person (the operator's own), the operator credential,
 * a home-possession credential or a peer Station delegation. No group ever
 * includes legacy `access:manage`. Device administration instead requires
 * the operator explicitly granting `access:devices`, and an Admin ceiling.
 */
import {
  DEVICE_REQUESTABLE_EXTRA_SCOPES,
  PAIRING_SCOPE_ACCESS_APPROVE,
  PAIRING_SCOPE_ACCESS_DEVICES,
  PAIRING_SCOPE_CONSENT_DECIDE,
  PAIRING_SCOPE_PRESETS,
  PAIRING_SCOPES,
  type PairingScope,
  parsePairingScope,
} from './environment-security.js';
import type { PersonalAccessToken } from './personal-tokens.js';

export const STATION_GROUPS = ['admin', 'member'] as const;
export type StationGroup = (typeof STATION_GROUPS)[number];

/** Anyone the operator has not placed in a group. */
export const DEFAULT_STATION_GROUP: StationGroup = 'member';

/** The permissions a group decides; nothing else is affected by groups. */
const GOVERNED: readonly PairingScope[] = [
  ...PAIRING_SCOPE_PRESETS.standard,
  ...DEVICE_REQUESTABLE_EXTRA_SCOPES,
  PAIRING_SCOPE_ACCESS_APPROVE,
  PAIRING_SCOPE_ACCESS_DEVICES,
  PAIRING_SCOPE_CONSENT_DECIDE,
];
export const STATION_GROUP_GOVERNED_SCOPES: readonly PairingScope[] =
  PAIRING_SCOPES.filter((token) => GOVERNED.includes(token));

/** The most each group allows, of the governed permissions. */
export const STATION_GROUP_CEILINGS: Readonly<
  Record<StationGroup, readonly PairingScope[]>
> = {
  admin: STATION_GROUP_GOVERNED_SCOPES,
  member: PAIRING_SCOPE_PRESETS.standard,
};

export const STATION_GROUP_LABELS: Readonly<
  Record<StationGroup, { label: string; summary: string }>
> = {
  admin: {
    label: 'Admin',
    summary:
      'Devices may have full device access, approve other devices, decide consent requests and manage device access when explicitly granted. Accounts stay with the operator.',
  },
  member: {
    label: 'Member',
    summary: 'Devices may read, start and steer work, and open a terminal.',
  },
};

export function isStationGroup(value: unknown): value is StationGroup {
  return (
    typeof value === 'string' &&
    (STATION_GROUPS as readonly string[]).includes(value)
  );
}

/**
 * `scope` with every governed permission `group` does not allow removed, in
 * the vocabulary's order. An unparseable scope stays as it is: the caller's
 * own parse refuses it.
 */
export function capScopeToGroup(scope: string, group: StationGroup): string {
  const tokens = parsePairingScope(scope);
  if (!tokens) return scope;
  const ceiling = STATION_GROUP_CEILINGS[group];
  return tokens
    .filter(
      (token) =>
        !STATION_GROUP_GOVERNED_SCOPES.includes(token) ||
        ceiling.includes(token),
    )
    .join(' ');
}

/** One person's group, as the operator's People page lists it. */
export interface StationGroupAssignment {
  principalId: string;
  group: StationGroup;
  /** False when the person sits in the default group by not being assigned. */
  assigned: boolean;
}

/** A device tied to a person, as the People page shows it. */
export interface StationPersonDevice {
  id: string;
  name: string;
  /** What the device was granted. */
  scope: string;
  /** What it may use: `scope` capped by the person's group. */
  effectiveScope: string;
}

/** `GET /api/pairing/people`: everyone with a group or a tied device. */
export interface StationPerson {
  principalId: string;
  displayName: string;
  group: StationGroup;
  /** False when the person sits in the default group by not being assigned. */
  assigned: boolean;
  devices: StationPersonDevice[];
  /** #3557: their active personal access tokens (never secrets). */
  tokens: PersonalAccessToken[];
  /**
   * #3557: whether a token can be made for them now: a live device ties
   * them by a Tailscale identity (an account's devices need its session,
   * which a script does not hold).
   */
  canHoldTokens: boolean;
}
