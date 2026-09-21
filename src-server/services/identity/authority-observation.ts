/**
 * Authority observation (#481 groundwork) — capture and revalidate the
 * closed public identity of the authority behind ONE authenticated request.
 *
 * Everything here is derived from facts the runtime auth middleware already
 * verified and from the canonical principal owner
 * (`resolveOrchestrationRequestPrincipal`, injected — never re-derived), so
 * there is no second identity store and no parallel resolution policy. The
 * observation is authorization-neutral: it describes authority, it grants
 * nothing, and every unresolved/conflicting/revoked shape fails closed with
 * the boundary's own error vocabulary — never a guessed identity and never
 * credential material in a payload or error.
 *
 * Release model: `captureAuthorityObservation` snapshots every fact the
 * release guard compares against, and `guardAuthorityObservationResponse`
 * (same streaming shape as `guardProjectResponse`/`guardAccountResponse`)
 * re-runs `revalidateAuthorityObservation` before the first body byte and
 * before every queued chunk. A post-`capture` `c.json` alone is NOT a
 * release guard — the JSON body can sit queued while authority changes —
 * so the route must publish through the guard, never the raw response.
 */

import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { AUTHORITY_OBSERVATION_SCHEMA_VERSION } from '@kontourai/station-contracts/authority-observation';
import type { DevicePrincipalBinding } from '@kontourai/station-contracts/environment-security';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { isRuntimeRequestPrincipalCurrent } from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import type { DeploymentAuthenticationService } from './deployment-authentication-service.js';

/** The caller context the canonical principal owner reads. */
export interface AuthorityObservationRequestContext {
  env: unknown;
  req: {
    raw: Request;
    header(name: string): string | undefined;
  };
}

/**
 * The verified boundary facts the observation reads. A `Pick` of the
 * canonical owners — never a restated union — so the release guard and the
 * middleware cannot drift apart on what "current" means.
 */
export type AuthorityObservationSecurity = Pick<
  EnvironmentSecurityService,
  | 'getPublicHandshake'
  | 'identifyDevice'
  | 'resolveGrantedScope'
  | 'authorizeCredential'
>;

export interface AuthorityObservationDeploymentAuthentication {
  service: Pick<DeploymentAuthenticationService, 'authenticate' | 'current'>;
}

/** Typed failure carrying the exact boundary-style status and code. */
export class AuthorityObservationRejected extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    readonly code:
      | 'authentication_required'
      | 'authority_changed'
      | 'authentication_unavailable',
  ) {
    super(`Authority observation rejected: ${code}`);
    this.name = 'AuthorityObservationRejected';
  }
}

/** Everything the release guard compares the world against. */
export interface CapturedAuthorityObservation {
  envelope: AuthorityObservation;
  credential: string;
  /** Whether a valid account session backed the CAPTURED principal. */
  accountWasAuthenticated: boolean;
  capturedDevice?: {
    id: string;
    principalBinding: DevicePrincipalBinding | undefined;
  };
  capturedScopes: readonly string[];
}

export interface CaptureAuthorityObservationInput {
  context: AuthorityObservationRequestContext;
  request: Request;
  runtimePrincipal: RuntimeAuthenticatedRequestPrincipal | undefined;
  security: AuthorityObservationSecurity;
  deploymentAuthentication?: AuthorityObservationDeploymentAuthentication;
  /** The canonical owner (`resolveOrchestrationRequestPrincipal`). */
  resolveRequestPrincipal: (
    context: AuthorityObservationRequestContext,
  ) => PrincipalRef;
}

function grantedScopeTokens(scope: string | undefined): readonly string[] {
  return (scope ?? '').split(' ').filter((token) => token.length > 0);
}

function failClosed(
  status: 401 | 403 | 503,
  code:
    | 'authentication_required'
    | 'authority_changed'
    | 'authentication_unavailable',
): never {
  throw new AuthorityObservationRejected(status, code);
}

/**
 * Canonical structural equality for a device person binding. Field-by-field
 * over the closed contract variants — never `JSON.stringify`, whose result
 * depends on key insertion order and would treat a reordered-but-identical
 * binding as drift (or miss drift a serializer normalizes away). Module
 * private: the release guard is its only caller, and behavior (not the
 * helper) is what the tests pin, so no new public surface is introduced
 * for it.
 */
function isSameDevicePrincipalBinding(
  left: DevicePrincipalBinding | undefined,
  right: DevicePrincipalBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  // Only the account variant carries `kind`; its presence discriminates the
  // union, so `in`-narrowing (not boolean locals, which do not narrow)
  // keeps both sides typed through the comparison.
  if ('kind' in left || 'kind' in right) {
    if (!('kind' in left && 'kind' in right)) return false;
    return (
      left.issuer === right.issuer &&
      left.subject === right.subject &&
      left.displayName === right.displayName &&
      left.approvedAt === right.approvedAt &&
      left.approvalId === right.approvalId &&
      left.approvedBy === right.approvedBy
    );
  }
  return (
    left.provider === right.provider &&
    left.subject === right.subject &&
    left.approvedAt === right.approvedAt &&
    left.approvalId === right.approvalId &&
    left.approvedBy === right.approvedBy
  );
}

/**
 * Resolve the observation ONCE, through the canonical owner, and snapshot
 * every fact the release guard will re-derive fresh.
 *
 * Ordering is load-bearing: every synchronous registry read (device,
 * scopes) is snapshotted — `structuredClone`d, never a retained live
 * reference — BEFORE the first `await`. A provider that hands out a shared
 * mutable record (or mutates one in place) cannot then move the captured
 * facts out from under the guard; the in-place-mutation race fails closed
 * at release instead of passing on the mutated values.
 */
export async function captureAuthorityObservation(
  input: CaptureAuthorityObservationInput,
): Promise<CapturedAuthorityObservation> {
  const {
    context,
    request,
    runtimePrincipal,
    security,
    deploymentAuthentication,
    resolveRequestPrincipal,
  } = input;
  if (
    runtimePrincipal?.kind !== 'credential' ||
    (runtimePrincipal.authority !== 'operator-credential' &&
      runtimePrincipal.authority !== 'device-credential')
  ) {
    // `kind: 'internal'` is the process-local attested-proxy token
    // (`runtime-http.ts` mints it only for the per-boot internal caller) —
    // not an app authority a multi-home client could observe — and every
    // operator/device credential the middleware accepts arrives as
    // `kind: 'credential'`. Fail closed either way: never a guessed basis.
    failClosed(401, 'authentication_required');
  }
  const { credential, authority } = runtimePrincipal;

  // Canonical owner — the SAME composition every orchestration route uses.
  // `PrincipalUnresolvedError` propagates to the route's fail-closed mapping.
  // The memoization means this is the CAPTURED principal, not proof of
  // currency — freshness is the release guard's job below.
  const resolved = resolveRequestPrincipal(context);
  if (resolved.kind !== 'human' && resolved.kind !== 'tenant') {
    // The canonical owner only ever yields human/tenant principals
    // (`principal-resolver.ts` mints nothing else in either mode); any other
    // kind is not an observable app authority here.
    failClosed(401, 'authentication_required');
  }

  // Synchronous registry facts, read ONCE and snapshotted BEFORE the
  // handshake `await`: one device lookup, one scope read, both cloned into
  // the capture. Nothing here retains a live registry reference.
  const capturedScopes: readonly string[] = grantedScopeTokens(
    security.resolveGrantedScope(credential),
  );
  let grant: AuthorityObservation['grant'];
  let capturedDevice: CapturedAuthorityObservation['capturedDevice'];
  if (authority === 'operator-credential') {
    grant = { kind: 'operator' };
    capturedDevice = undefined;
  } else {
    const device = security.identifyDevice(credential);
    if (!device) failClosed(401, 'authentication_required');
    grant = {
      kind: 'device',
      deviceId: device.id,
      grantedScopes: capturedScopes,
    };
    capturedDevice = {
      id: device.id,
      principalBinding: structuredClone(device.principalBinding),
    };
  }

  // The CAPTURE-time account basis is, by design, the cached per-request
  // result the canonical owner itself consulted (`current()`); the FRESH
  // re-check below re-authenticates. Recording the basis here is what lets
  // the re-check distinguish "account was and must remain the principal's
  // basis" from "no account was involved".
  const accountBasis = deploymentAuthentication?.service.current(request);
  const accountWasAuthenticated = accountBasis?.kind === 'authenticated';

  const environmentId = (await security.getPublicHandshake()).environmentId;

  return {
    envelope: {
      schemaVersion: AUTHORITY_OBSERVATION_SCHEMA_VERSION,
      environmentId,
      principal: { kind: resolved.kind, id: resolved.id },
      grant,
    },
    credential,
    accountWasAuthenticated,
    capturedDevice,
    capturedScopes,
  };
}

export interface RevalidateAuthorityObservationInput {
  request: Request;
  captured: CapturedAuthorityObservation;
  security: AuthorityObservationSecurity;
  deploymentAuthentication?: AuthorityObservationDeploymentAuthentication;
}

interface FreshCredentialFacts {
  current: boolean;
  device: {
    id: string;
    principalBinding: DevicePrincipalBinding | undefined;
  } | null;
  scopes: readonly string[];
}

/** The cheap synchronous facts, re-derived fresh on every call. */
function readFreshCredentialFacts(
  request: Request,
  captured: CapturedAuthorityObservation,
  security: AuthorityObservationSecurity,
): FreshCredentialFacts {
  const current = isRuntimeRequestPrincipalCurrent(request, security);
  const device =
    captured.capturedDevice === undefined
      ? null
      : (() => {
          const fresh = security.identifyDevice(captured.credential);
          if (!fresh) return null;
          return { id: fresh.id, principalBinding: fresh.principalBinding };
        })();
  return {
    current,
    device,
    scopes: grantedScopeTokens(
      security.resolveGrantedScope(captured.credential),
    ),
  };
}

function requireCredentialFactsMatch(
  captured: CapturedAuthorityObservation,
  fresh: FreshCredentialFacts,
): void {
  if (!fresh.current) failClosed(401, 'authentication_required');
  if (captured.capturedDevice !== undefined) {
    if (!fresh.device) failClosed(401, 'authentication_required');
    if (
      fresh.device.id !== captured.capturedDevice.id ||
      !isSameDevicePrincipalBinding(
        fresh.device.principalBinding,
        captured.capturedDevice.principalBinding,
      )
    ) {
      failClosed(403, 'authority_changed');
    }
  }
  if (
    fresh.scopes.length !== captured.capturedScopes.length ||
    fresh.scopes.some(
      (scope, index) => scope !== captured.capturedScopes[index],
    )
  ) {
    failClosed(403, 'authority_changed');
  }
}

/**
 * Fresh-fact release guard, run before the first body byte and before every
 * queued chunk (see `guardAuthorityObservationResponse`). Every check
 * re-derives the fact FRESH — re-reading the cached per-request account
 * result would not prove the current principal, so the account tier always
 * re-`authenticate`s here (which also refreshes the per-request record
 * later readers see). Any drift fails closed with the boundary's own
 * vocabulary; nothing about the error reveals credential material or
 * account details.
 *
 * Ordering closes the revocation-during-`await` window, and the account
 * round-trip is deliberately the LAST `await` so the final authority proof
 * is a fresh provider verdict, never the cached per-request result:
 * synchronous credential/binding/scope facts are checked BEFORE the
 * environment and account `await`s AND AGAIN after the last one, so
 * anything revoked, rebound, or rescoped while either round-trip was in
 * flight fails closed, and an account session lost during the environment
 * read is caught by the trailing `authenticate()`. The environment read
 * sits before it because an environment rotation (reset) always mints a
 * new credential with it — a home identity that moved without invalidating
 * the credential is not a transition this service supports — so the
 * post-`await` credential re-derivation covers the only observable drift,
 * and the delivery guard re-runs this whole check per chunk regardless.
 * Exactly one provider round-trip per check: no authenticate/handshake
 * retry loop by design.
 *
 * Holds no lock across consumption: every fact here is a bounded read
 * (registry lookups, one provider round-trip, one record read). In
 * particular no auth mutex is acquired, so a slow consumer cannot wedge
 * unrelated authentication work.
 */
export async function revalidateAuthorityObservation(
  input: RevalidateAuthorityObservationInput,
): Promise<void> {
  const { request, captured, security, deploymentAuthentication } = input;
  requireCredentialFactsMatch(
    captured,
    readFreshCredentialFacts(request, captured, security),
  );

  const freshEnvironmentId = (await security.getPublicHandshake())
    .environmentId;
  if (freshEnvironmentId !== captured.envelope.environmentId) {
    failClosed(403, 'authority_changed');
  }

  if (deploymentAuthentication) {
    const account =
      await deploymentAuthentication.service.authenticate(request);
    if (account.kind === 'authenticated') {
      if (account.principal.id !== captured.envelope.principal.id) {
        // A now-valid account session resolving to a DIFFERENT principal
        // means the canonical owner would resolve this request differently
        // than the observation we are about to publish.
        failClosed(403, 'authority_changed');
      }
    } else if (account.kind === 'invalid') {
      failClosed(401, 'authentication_required');
    } else if (account.kind === 'unavailable') {
      failClosed(503, 'authentication_unavailable');
    } else if (captured.accountWasAuthenticated) {
      // The account session that backed the captured principal is gone.
      failClosed(401, 'authentication_required');
    }
  }

  // Post-`await` re-derivation: anything revoked, rebound, or rescoped
  // while the environment/account round-trips were in flight fails here.
  requireCredentialFactsMatch(
    captured,
    readFreshCredentialFacts(request, captured, security),
  );
}

/**
 * Delivery guard for the observation body — the same streaming shape as
 * `guardProjectResponse`/`guardAccountResponse`, but a dedicated owner
 * rather than a reuse: neither sibling can express this route's refusal.
 * `guardProjectResponse` answers a single project 404, and
 * `guardAccountResponse` a boolean/tri-state account verdict mapped to
 * account codes; the observation refuses with its own typed
 * status+code (`AuthorityObservationRejected`) spanning the credential,
 * binding, scope, environment, AND account tiers. A shared generic would
 * only reintroduce that vocabulary as a parameter — the duplication it
 * would remove is the streaming skeleton, which is exactly the part each
 * owner must keep reviewable next to its own failure mapping.
 *
 * Revalidates before the first byte (cancelling the queued body on drift
 * so no stale observation is published) and before every chunk; sets
 * `no-store` on whatever leaves this seam.
 */
export async function guardAuthorityObservationResponse(
  response: Response,
  revalidate: () => Promise<void>,
): Promise<Response> {
  const refused = await refuseIfStale(response, revalidate);
  if (refused) return refused;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const reader = response.body.getReader();
  let closed = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (closed) return;
        try {
          const next = await reader.read();
          if (next.done) {
            closed = true;
            controller.close();
            return;
          }
          try {
            await revalidate();
          } catch (error) {
            if (!(error instanceof AuthorityObservationRejected)) throw error;
            throw new Error(
              'Authority observation ended before response delivery.',
            );
          }
          controller.enqueue(next.value);
        } catch (error) {
          closed = true;
          void reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        closed = true;
        void reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function refuseIfStale(
  response: Response,
  revalidate: () => Promise<void>,
): Promise<Response | undefined> {
  try {
    await revalidate();
  } catch (error) {
    if (!(error instanceof AuthorityObservationRejected)) throw error;
    void response.body?.cancel().catch(() => {});
    return Response.json(
      { error: { code: error.code } },
      {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
  return undefined;
}
