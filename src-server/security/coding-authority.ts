/**
 * Who may act on this computer through a Project's folder (#2412).
 *
 * One derivation, read by the coding routes' `POST /exec` gate and by the
 * project routes' `workingDirectory` gate, so "the operator in person" and
 * "a device the operator allowed to run commands" cannot come to mean two
 * different things in two places.
 */
import {
  PAIRING_SCOPE_APPROVAL_FULL_ACCESS,
  PAIRING_SCOPE_CODING_EXEC,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import { isAgentOriginatedRequest } from '../runtime/mcp/station-control-caller.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundRuntimeLocalOperator,
} from './runtime-request-security.js';

/**
 * #2436 review: a request an agent's station-control tool made. Those tools
 * call Station's REST API with the per-boot internal token, which the auth
 * boundary binds as Station's own internal principal with home-possession,
 * so `isOperatorInPerson` reads it as the operator. The tool's origin
 * marker or caller credential tells them apart, and may only RESTRICT
 * (`isAgentOriginatedRequest`): its absence proves nothing, so this refuses
 * more than before and never grants more.
 */
function actsForAnAgent(request: Request): boolean {
  return isAgentOriginatedRequest(request);
}

/**
 * The operator in person, as opposed to a paired device. True for the
 * operator credential and for a credential minted by proving possession of
 * this Station's home (the desktop app's local grant, the host browser's
 * bootstrap, Station's own internal token), which the auth boundary binds
 * once per request. A paired device, a LAN browser admitted through an
 * access request, and a collaborator's browser are all NOT in person, and
 * neither is a request no auth boundary saw.
 */
export function isOperatorInPerson(request: Request): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (!principal) return false;
  return (
    principal.authority === 'operator-credential' ||
    isBoundRuntimeLocalOperator(request)
  );
}

/**
 * The operator in person, or a caller the auth boundary accepted whose
 * granted scope carries `coding:exec` (a device the operator allowed to run
 * commands, once, from its access editor). `grantedScope` is the scope the
 * boundary published for this request; absent is refused.
 */
export function mayRunCommandsOnHost(
  request: Request,
  grantedScope: string | undefined,
): boolean {
  // An agent is neither the operator nor a granted device; it has its own
  // engine shell, under its own approval posture.
  if (actsForAnAgent(request)) return false;
  if (isOperatorInPerson(request)) return true;
  if (!getRuntimeAuthenticatedRequestPrincipal(request)) return false;
  return (
    grantedScope !== undefined &&
    pairingScopeIncludes(grantedScope, PAIRING_SCOPE_CODING_EXEC)
  );
}

/**
 * #2436 (owner decision 2026-09-23): whether this request may put a session,
 * or an Agent's default, at full access (approval posture `never`). The
 * operator in person, or a caller the auth boundary accepted whose granted
 * scope carries `approval:full-access` (a device the operator allowed, once,
 * from its access editor). Tightening, and a Default pick, need neither.
 * Never a request an agent's station-control tool made (`actsForAnAgent`).
 */
export function mayGrantFullAccess(
  request: Request,
  grantedScope: string | undefined,
): boolean {
  // An agent may never give itself, or any session, full access.
  if (actsForAnAgent(request)) return false;
  if (isOperatorInPerson(request)) return true;
  if (!getRuntimeAuthenticatedRequestPrincipal(request)) return false;
  return (
    grantedScope !== undefined &&
    pairingScopeIncludes(grantedScope, PAIRING_SCOPE_APPROVAL_FULL_ACCESS)
  );
}

declare const fullAccessGrantBrand: unique symbol;

/**
 * #2436: proof, derived from one request by `fullAccessGrantFor`, that the
 * request may put a session at full access. A seam that starts sessions on a
 * caller's behalf (`TaskDispatcher.dispatch`) takes `FullAccessGrant | null`
 * as a required input, so every caller states its authority where it calls,
 * and only a request's own authority can produce a grant. Unattended callers
 * (monitors, the board intent, e2e control) pass `null`.
 */
export type FullAccessGrant = { readonly [fullAccessGrantBrand]: true };

export function fullAccessGrantFor(
  request: Request,
  grantedScope: string | undefined,
): FullAccessGrant | null {
  return mayGrantFullAccess(request, grantedScope)
    ? (Object.freeze({}) as FullAccessGrant)
    : null;
}
