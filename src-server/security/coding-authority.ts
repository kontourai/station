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
 * #2436 review, #2493 review F1: a request that may be an agent's. An
 * agent's station-control tools call Station's REST API with the per-boot
 * internal token, which the auth boundary binds as Station's own internal
 * principal with home-possession, so `isOperatorInPerson` reads it as the
 * operator. The tool's origin marker or caller credential identifies such a
 * call (`isAgentOriginatedRequest`), but its ABSENCE proves nothing: any
 * holder of the token can omit it. So every request the internal principal
 * carries counts, keyed exactly as `createAgentDispatchActorResolver` keys
 * it. The operator never reaches Station that way: the UI proxy marks its
 * hop `remote` and needs the browser's own credential, and the token's
 * other holders (the Station-agent relay, the CLI's readiness probe) send no
 * approval or command request.
 */
function actsForAnAgent(request: Request): boolean {
  return (
    isAgentOriginatedRequest(request) ||
    getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal'
  );
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
 * Never a request that may be an agent's (`actsForAnAgent`): the internal
 * principal, with or without the station-control origin marker.
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

/**
 * #2436: proof, derived from one request by `fullAccessGrantFor`, that the
 * request may put a session at full access. A seam that starts sessions on a
 * caller's behalf (`TaskDispatcher.dispatch`) takes `FullAccessGrant | null`
 * as a required input, so every caller states its authority where it calls,
 * and checks it with `isFullAccessGrant`. Unattended callers (monitors, the
 * board intent, e2e control) pass `null`.
 *
 * The class is private to this module and has a private member, so no
 * object literal satisfies the type and no other module can construct one:
 * a cast (`{} as FullAccessGrant`) type-checks but fails `instanceof`.
 */
class FullAccessGrantProof {
  // Type-only and private: makes the type nominal, so a structural
  // look-alike does not type-check. `isFullAccessGrant` is the runtime check.
  declare private readonly nominal: true;
}

export type FullAccessGrant = FullAccessGrantProof;

export function fullAccessGrantFor(
  request: Request,
  grantedScope: string | undefined,
): FullAccessGrant | null {
  return mayGrantFullAccess(request, grantedScope)
    ? new FullAccessGrantProof()
    : null;
}

/** Whether `value` is a grant this module minted (never a look-alike). */
export function isFullAccessGrant(value: unknown): value is FullAccessGrant {
  return value instanceof FullAccessGrantProof;
}

/**
 * TEST-ONLY. A grant for unit tests of the seams that enforce one. Throws
 * outside the test runner, so production code cannot mint a grant without
 * a request.
 */
export function fullAccessGrantForTesting(): FullAccessGrant {
  if (process.env.VITEST !== 'true')
    throw new Error('fullAccessGrantForTesting is test-only.');
  return new FullAccessGrantProof();
}
