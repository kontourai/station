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
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundRuntimeLocalOperator,
} from './runtime-request-security.js';

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
 */
export function mayGrantFullAccess(
  request: Request,
  grantedScope: string | undefined,
): boolean {
  if (isOperatorInPerson(request)) return true;
  if (!getRuntimeAuthenticatedRequestPrincipal(request)) return false;
  return (
    grantedScope !== undefined &&
    pairingScopeIncludes(grantedScope, PAIRING_SCOPE_APPROVAL_FULL_ACCESS)
  );
}
