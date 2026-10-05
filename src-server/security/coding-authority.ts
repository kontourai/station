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
  return requestMayBeAnAgent(request);
}

/** {@link actsForAnAgent}, for the full-access refusal's wording (#1796). */
export function requestMayBeAnAgent(request: Request): boolean {
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
function isOperatorInPerson(request: Request): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (!principal) return false;
  return (
    principal.authority === 'operator-credential' ||
    isBoundRuntimeLocalOperator(request)
  );
}

/**
 * #2493 delta review: the operator in person AND not a request that may be
 * an agent's (`actsForAnAgent`). `isOperatorInPerson` alone reads Station's
 * internal principal as the operator, because the per-boot token is minted
 * with home-possession; a gate that grants the operator something outside
 * Project confinement must use this instead.
 */
export function isOperatorInPersonNotAgent(request: Request): boolean {
  return isOperatorInPerson(request) && !actsForAnAgent(request);
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
 * The refusal code for choosing a folder on this computer without the
 * authority to run commands there. One code for every route that takes a
 * folder, so the Project routes and the session-start routes cannot answer
 * the same rule two ways.
 */
export const WORKING_DIRECTORY_NOT_GRANTED_CODE =
  'working-directory-not-granted' as const;

/**
 * Choosing a working folder takes the same authority as running commands
 * there: the folder is where an engine session or a Project's coding routes
 * run. The one rule behind `POST /api/projects`' and `PUT
 * /api/projects/:slug`' `workingDirectory` and behind a session start that
 * names a plain folder.
 */
export function mayChooseWorkingDirectory(
  request: Request,
  grantedScope: string | undefined,
): boolean {
  return mayRunCommandsOnHost(request, grantedScope);
}

/**
 * Whether a request that names a folder must be refused. Fail closed: it is
 * refused unless the caller is Station's own server code (a station-control
 * tool call is confined by `scopeDispatch`) or
 * {@link mayChooseWorkingDirectory} passes (the operator in person, or a
 * device holding `coding:exec`). A caller of any other kind, including one
 * added later, is refused.
 */
export function refusesWorkingDirectoryChoice(
  request: Request,
  grantedScope: string | undefined,
): boolean {
  if (getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal')
    return false;
  return !mayChooseWorkingDirectory(request, grantedScope);
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
  /**
   * #1796: who granted it, derived from the same request: the operator in
   * person, or the paired device holding `approval:full-access`. Every
   * start the grant unconfines records this beside its `host` stamp, so
   * revoking that device finds it, whichever path carried the grant.
   */
  constructor(readonly grantor: FullAccessGrantor | null) {}
}

/** #1796: the actor a full-access grant came from. */
export type FullAccessGrantor =
  | { readonly kind: 'operator' }
  | { readonly kind: 'device'; readonly deviceId: string };

export type FullAccessGrant = FullAccessGrantProof;

export function fullAccessGrantFor(
  request: Request,
  grantedScope: string | undefined,
): FullAccessGrant | null {
  if (!mayGrantFullAccess(request, grantedScope)) return null;
  // #1796: a grant always names its grantor. A caller that may grant full
  // access but is neither the operator in person nor a paired device is
  // refused rather than granted anonymously: nothing could revoke it.
  if (isOperatorInPerson(request))
    return new FullAccessGrantProof({ kind: 'operator' });
  const deviceId = getRuntimeAuthenticatedRequestPrincipal(request)?.deviceId;
  return deviceId
    ? new FullAccessGrantProof({ kind: 'device', deviceId })
    : null;
}

/** #1796: the grantor a grant names; `null` for one that names none. */
export function fullAccessGrantor(
  grant: FullAccessGrant,
): FullAccessGrantor | null {
  return grant.grantor;
}

/**
 * #1796: a start carrying a full-access grant that names no grantor. The
 * start path refuses it: an unconfined session nothing could revoke.
 */
export class UnattributedFullAccessGrantError extends Error {
  constructor() {
    super(
      'A full-access grant must name who granted it; this start was refused.',
    );
    this.name = 'UnattributedFullAccessGrantError';
  }
}

/** Whether `value` is a grant this module minted (never a look-alike). */
export function isFullAccessGrant(value: unknown): value is FullAccessGrant {
  return value instanceof FullAccessGrantProof;
}

/**
 * #2377 slice C1: a seam that records an approval pick itself (the
 * foreground executor, which alone knows the pick's thread) refuses one that
 * resolves to full access without the request's grant. The routes answer it
 * with the same 403 as `refuseUngrantedFullAccess`.
 */
export class FullAccessNotGrantedError extends Error {
  constructor() {
    super('This request may not give an agent full access.');
    this.name = 'FullAccessNotGrantedError';
  }
}

/**
 * TEST-ONLY. A grant for unit tests of the seams that enforce one. Throws
 * outside the test runner, so production code cannot mint a grant without
 * a request.
 */
export function fullAccessGrantForTesting(
  grantor: FullAccessGrantor | null = { kind: 'operator' },
): FullAccessGrant {
  if (process.env.VITEST !== 'true')
    throw new Error('fullAccessGrantForTesting is test-only.');
  return new FullAccessGrantProof(grantor);
}
