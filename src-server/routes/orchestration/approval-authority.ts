/**
 * #2436 (owner decision 2026-09-23): full access (approval posture `never`)
 * needs the operator in person or a device holding `approval:full-access`,
 * on every route that can put a session there: recording it
 * (`setApprovalMode`), carrying it on a send, or asking for it on a start or
 * turn's `modelOptions`. Tightening needs neither. A Default pick needs the
 * grant only where it would run the engine at `never` unconfined, on a
 * `host`-stamped session (#2377 slice C1); elsewhere the owner decided a
 * member may pick it (2026-09-23, fork 1).
 * `mayGrantFullAccess` (security/coding-authority.ts) is the one derivation;
 * this only reads the request's granted scope and shapes the refusal.
 */
import type { Context } from 'hono';
import { isKnownFullAccessAcpModeId } from '../../providers/adapters/acp-session-mode.js';
import {
  type FullAccessGrant,
  FullAccessNotGrantedError,
  fullAccessGrantFor,
  mayGrantFullAccess,
} from '../../security/coding-authority.js';
import { fullAccessRefusalBody } from '../../security/full-access-refusal.js';
import {
  ManagedApprovalCeilingRefusedError,
  managedApprovalCeilingFailureBody,
  managedApprovalCeilingRefusalBody,
  managedCeilingRefuses,
} from '../../security/managed-approval-ceiling.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';

/**
 * The 403 for a refused full-access request (#1796): who asked, which
 * Station refused, and what only its operator can do about it
 * (`security/full-access-refusal.ts`).
 */
export function fullAccessRefusal(c: Context): Response {
  return c.json(fullAccessRefusalBody(c.req.raw), 403);
}

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
 * #4518: the 403 for a posture above the machine's managed approval ceiling.
 * It names the organization and its support link, not a grant to ask for:
 * nobody on this Station can grant past the policy.
 */
export function managedApprovalCeilingRefusal(c: Context): Response {
  return c.json(managedApprovalCeilingRefusalBody(), 403);
}

/**
 * The managed 403 when `error`, or any error in its `cause` chain, is a
 * ceiling refusal that settled definitively (see
 * `managedApprovalCeilingFailureBody`). Undefined otherwise, including when
 * an indeterminate error is reached first, so the caller's indeterminate
 * answer wins.
 */
export function managedApprovalCeilingFailure(
  c: Context,
  error: unknown,
): Response | undefined {
  const body = managedApprovalCeilingFailureBody(error);
  return body ? c.json(body, 403) : undefined;
}

/**
 * #4518: a 403 when any of `modes` is a posture broader than the managed
 * ceiling; `undefined` otherwise. A pick is refused, not lowered: lowering a
 * choice someone made would claim a posture they did not choose.
 */
export function refuseAboveManagedCeiling(
  c: Context,
  modes: readonly unknown[],
): Response | undefined {
  return modes.some(managedCeilingRefuses)
    ? managedApprovalCeilingRefusal(c)
    : undefined;
}

/**
 * A 403 when any of `modes` is full access and this request may not grant
 * it; `undefined` otherwise. #4518: under a managed ceiling below full
 * access the refusal is the managed one, because no grant could help.
 */
export function refuseUngrantedFullAccess(
  c: Context,
  modes: readonly unknown[],
): Response | undefined {
  if (!modes.includes('never')) return undefined;
  if (managedCeilingRefuses('never')) return managedApprovalCeilingRefusal(c);
  if (
    mayGrantFullAccess(
      c.req.raw,
      grantedPairingScope(c as unknown as PairingScopeContextStore),
    )
  )
    return undefined;
  return fullAccessRefusal(c);
}

/**
 * A 403 when a start or turn's `modelOptions` (the default channel: a
 * client's default, the CLI's `--approval-mode`) asks for full access and
 * this request may not grant it; `undefined` otherwise.
 *
 * #4518: a carried `approvalMode` is a default, not a pick, so under a
 * managed ceiling below full access it is not refused: `ApprovalPosture`
 * lowers it to the ceiling where it applies. A known ACP full-access mode id
 * (`requestedApprovalMode`) is not lowered by anything, so it is still
 * refused, with the managed refusal.
 */
export function refuseUngrantedCarriedFullAccess(
  c: Context,
  options: unknown,
): Response | undefined {
  if (requestedApprovalMode(options) !== 'never') return undefined;
  const acpFullAccess = isKnownFullAccessAcpModeId(
    (options as Record<string, unknown>).mode,
  );
  if (managedCeilingRefuses('never') && !acpFullAccess) return undefined;
  return refuseUngrantedFullAccess(c, ['never']);
}

/**
 * #2377 slice C1: a recorded pick is checked by the posture it puts the
 * session in, not only by its literal value. A Default (`connection-default`)
 * is asked `reachesFullAccess`
 * (`OrchestrationService.approvalPickReachesFullAccess`: the resolution a
 * turn applies, on a `host`-stamped session), so a Default that would run the
 * engine at `never` unconfined needs the same grant as `never`. A check that
 * fails counts as full access.
 */
export async function refuseUngrantedPick(
  c: Context,
  pick: unknown,
  reachesFullAccess: () => Promise<boolean>,
): Promise<Response | undefined> {
  if (pick !== 'connection-default')
    return (
      refuseAboveManagedCeiling(c, [pick]) ??
      refuseUngrantedFullAccess(c, [pick])
    );
  let fullAccess: boolean;
  try {
    fullAccess = await reachesFullAccess();
  } catch {
    fullAccess = true;
  }
  return fullAccess ? refuseUngrantedFullAccess(c, ['never']) : undefined;
}

/**
 * #2377 slice C1: the 403 for a pick a recording seam refused itself
 * (`FullAccessNotGrantedError`, thrown by the foreground executor, which
 * alone knows a carried pick's thread).
 */
export function fullAccessRefusalFor(
  c: Context,
  error: unknown,
): Response | undefined {
  if (error instanceof ManagedApprovalCeilingRefusedError)
    return managedApprovalCeilingRefusal(c);
  return error instanceof FullAccessNotGrantedError
    ? fullAccessRefusal(c)
    : undefined;
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
