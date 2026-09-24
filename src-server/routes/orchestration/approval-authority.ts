/**
 * #2436 (owner decision 2026-09-23): full access (approval posture `never`)
 * needs the operator in person or a device holding `approval:full-access`,
 * on every route that can put a session there: recording it
 * (`setApprovalMode`), carrying it on a send, or asking for it on a start or
 * turn's `modelOptions`. Tightening, and a Default pick, need neither.
 * `mayGrantFullAccess` (security/coding-authority.ts) is the one derivation;
 * this only reads the request's granted scope and shapes the refusal.
 */
import { APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE } from '@kontourai/station-contracts/orchestration';
import type { Context } from 'hono';
import { isKnownFullAccessAcpModeId } from '../../providers/adapters/acp-session-mode.js';
import {
  type FullAccessGrant,
  fullAccessGrantFor,
  mayGrantFullAccess,
} from '../../security/coding-authority.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';

export const APPROVAL_FULL_ACCESS_NOT_GRANTED = {
  success: false as const,
  code: APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE,
  error:
    "This device is not allowed to give an agent full access. The Station's operator can allow it: Devices, this device's access, Allow full access.",
};

/**
 * The approval posture a `modelOptions` bag asks for, if any. #2569: an ACP
 * `mode` whose id is on `KNOWN_FULL_ACCESS_ACP_MODE_IDS` (an agent's own
 * permission bypass: `bypassPermissions`, `full-access`, `yolo`) asks for
 * full access too, so it reads as `never` here and needs the same grant.
 *
 * Accepted residual: the route cannot see an agent's advertised catalog, so
 * a mode the agent declares full access ONLY through `_meta.kind:
 * "full_access"`, under an id not on the list, is not refused here; the
 * adapter still withholds it outside a `host` session, but on a `host`
 * session a caller without the grant can select it on a turn. A
 * full-access mode with neither a listed id nor that `_meta` declaration is
 * not recognised anywhere.
 */
export function requestedApprovalMode(options: unknown): unknown {
  if (!options || typeof options !== 'object') return undefined;
  const bag = options as Record<string, unknown>;
  return isKnownFullAccessAcpModeId(bag.mode) ? 'never' : bag.approvalMode;
}

/**
 * A 403 when any of `modes` is full access and this request may not grant
 * it; `undefined` otherwise.
 */
export function refuseUngrantedFullAccess(
  c: Context,
  modes: readonly unknown[],
): Response | undefined {
  if (!modes.includes('never')) return undefined;
  if (
    mayGrantFullAccess(
      c.req.raw,
      grantedPairingScope(c as unknown as PairingScopeContextStore),
    )
  )
    return undefined;
  return c.json(APPROVAL_FULL_ACCESS_NOT_GRANTED, 403);
}

/**
 * This request's full-access grant, for a seam that enforces it itself
 * (`TaskDispatcher.dispatch`). `null` when the request may not grant it.
 */
export function fullAccessGrantForRequest(c: Context): FullAccessGrant | null {
  return fullAccessGrantFor(
    c.req.raw,
    grantedPairingScope(c as unknown as PairingScopeContextStore),
  );
}
