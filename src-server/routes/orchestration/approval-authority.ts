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
import { mayGrantFullAccess } from '../../security/coding-authority.js';
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

/** The approval mode a `modelOptions` bag asks for, if any. */
export function requestedApprovalMode(options: unknown): unknown {
  return options && typeof options === 'object'
    ? (options as Record<string, unknown>).approvalMode
    : undefined;
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
