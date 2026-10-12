/**
 * #3279: which resolved principals may own a connected-account credential.
 *
 * The owner is always an existing `PrincipalRef.id` from the request or
 * session-owner resolution; this module never mints an id. It only decides
 * whether that principal is a person who can hold their own tool account:
 *
 * - `human:` principals with a verified identity, and the verified local
 *   operator (`human:local:operator`), may own one.
 * - Per-device attribution (`human:device:<id>`, a paired device without a
 *   person binding) may not: a device is not a person, and keying a person's
 *   mailbox token to one phone would split one human into several owners.
 *   Such a caller gets "connect your account" with no personal ownership.
 * - `service:`, `agent:` and `tenant:` principals may not.
 *
 * Hosted (tenant-qualified) turns are refused for now: their authorized turn
 * correlation carries a tenant-qualified digest rather than the
 * `PrincipalRef.id`, so a person's credential could not be selected without
 * inventing a second id.
 *
 * This is ownership, not authorization: the routes that reach it are already
 * gated by the request's pairing scope and principal resolution.
 */
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { DEVICE_IDENTITY_PROVIDER } from './identity-source.js';
import {
  PrincipalUnresolvedError,
  principalForRecordedSessionOwner,
} from './principal-resolver.js';

const DEVICE_PRINCIPAL_PREFIX = `human:${DEVICE_IDENTITY_PROVIDER}:`;
const TENANT_QUALIFIED_ACCOUNT_PREFIX = 'tenant-account:';

/** The owner id for this resolved principal, or `undefined` when it cannot own one. */
export function connectedAccountOwnerId(
  principal: PrincipalRef,
): string | undefined {
  if (!isPrincipalRef(principal) || principal.kind !== 'human')
    return undefined;
  if (principal.id.startsWith(DEVICE_PRINCIPAL_PREFIX)) return undefined;
  return principal.id;
}

/**
 * The owner id for an authorized turn's correlation account (the session
 * owner's recorded `PrincipalRef.id` in a personal Station).
 */
export function connectedAccountOwnerIdForTurnAccount(
  accountId: string | undefined,
): string | undefined {
  if (!accountId || accountId.startsWith(TENANT_QUALIFIED_ACCOUNT_PREFIX))
    return undefined;
  try {
    return connectedAccountOwnerId(principalForRecordedSessionOwner(accountId));
  } catch (error) {
    if (error instanceof PrincipalUnresolvedError) return undefined;
    throw error;
  }
}
