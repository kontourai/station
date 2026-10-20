import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { Context } from 'hono';
import type { createAttentionRoutes } from '../../routes/orchestration/attention.js';
import { scopeDispatch } from '../../routes/orchestration/dispatch-scope.js';
import { isNonPersonCaller } from '../../routes/plugins/plugin-person-approval.js';
import {
  pairingScopeSatisfiesHttpRoute,
  requiredPairingScope,
} from '../../security/pairing-route-scopes.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  getRuntimeAuthenticatedRequestPrincipal,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { StationControlDispatchScope } from '../mcp/station-control-dispatch-scope.js';

type AttentionRouteOptions = NonNullable<
  Parameters<typeof createAttentionRoutes>[1]
>;

export interface RuntimeAttentionRouteDependencies {
  readAuthorityForRequest: (request: Request) => SessionReadAuthority;
  resolvePrincipal: (c: Context) => { id: string };
  security: CurrentRuntimeRequestPrincipalSecurity & {
    credentialMayDecidePairingRequests(credential: string): boolean;
  };
  stationControlDispatchScope: StationControlDispatchScope | undefined;
}

/**
 * The runtime's `/api/attention` reader predicates, composed in one place so
 * the composition itself is testable (each predicate decides an affordance
 * the inbox offers, so a dropped or constant predicate is a real defect).
 */
export function runtimeAttentionRouteOptions(
  deps: RuntimeAttentionRouteDependencies,
): AttentionRouteOptions {
  return {
    readAuthorityForRequest: deps.readAuthorityForRequest,
    // #2323 S5 review M6: plugin proposals are addressed to the operator,
    // decided by the same resolver `/api/plugin-proposals` reads.
    // Station's own agents resolve as the operator too; they see none
    // (#2323 S5 delta review).
    viewerIsOperator: (c) => {
      if (isNonPersonCaller(c.req.raw)) return false;
      try {
        return deps.resolvePrincipal(c).id === LOCAL_OPERATOR_PRINCIPAL_ID;
      } catch {
        return false;
      }
    },
    // Models the two gates this Station applies before the handler of the
    // route that answers a paired-Station request: the HTTP boundary
    // (credential + pairing scope for that exact path), then the
    // station-control dispatch scope on a remote task. A decision posts to
    // `respond` (`approve`); an input answer to `continue` (`execute`). The
    // handler itself can still refuse (an inbound delegation peer, hosted
    // mode, an environment it cannot resolve or that is not the task's
    // recorded host), and the paired Station authorizes on its side.
    viewerMayRespondToPeerTask: (c, taskId, requestType) =>
      mayAnswerDelegatedRequest(deps, c, taskId, requestType, true),
    // #765 D5: derive the device-pairing items' `viewerCanDecide` from the
    // SAME two gates the middleware applies to an approve/deny request, in
    // the same order: the pairing family's authority boundary
    // (`authorizeCredential`, via the exported predicate) and then the
    // scope requirement for the confirm/deny leaves, including the narrow
    // explicit approval grant. The same matcher runs at ingress and delayed
    // revalidation, so an operator-promoted device need not carry management
    // authority to decide a pending request.
    // The attested internal principal (station-control/MCP) bypasses both
    // gates in `configureRuntimeHttp`, so it decides too; an absent
    // principal or an unmapped table entry fails closed.
    viewerMayDecidePairingRequests: (request) => {
      const principal = getRuntimeAuthenticatedRequestPrincipal(request);
      if (!principal) return false;
      if (principal.kind === 'internal') return true;
      if (
        !deps.security.credentialMayDecidePairingRequests(principal.credential)
      )
        return false;
      // Confirm and deny share the `/api/pairing` single-tier rule
      // (method-agnostic), so one representative leaf answers for both.
      const requiredScope = requiredPairingScope(
        'POST',
        '/api/pairing/requests/:requestId/confirm',
      );
      if (requiredScope === undefined) return false;
      const grantedScope = deps.security.resolveGrantedScope(
        principal.credential,
      );
      return (
        grantedScope !== undefined &&
        pairingScopeSatisfiesHttpRoute(grantedScope, requiredScope, {
          method: 'POST',
          path: '/api/pairing/requests/request/confirm',
        })
      );
    },
  };
}

/**
 * Whether THIS request's caller passes the HTTP boundary and the
 * station-control dispatch scope for the route that answers a delegated
 * task's open request: `continue` with `execute` for an `input` question,
 * `respond` with `approve` otherwise. `remote` names whether the task runs
 * on another Station. A model of those two gates only.
 */
export function mayAnswerDelegatedRequest(
  deps: {
    security: CurrentRuntimeRequestPrincipalSecurity;
    stationControlDispatchScope: StationControlDispatchScope | undefined;
  },
  c: Context,
  taskId: string,
  requestType: string | undefined,
  remote: boolean,
): boolean {
  const answer = requestType === 'input';
  const path = `/api/orchestration/delegations/${encodeURIComponent(taskId)}/${
    answer ? 'continue' : 'respond'
  }`;
  if (
    !runtimeRequestPrincipalMayAccessHttpRoute(c.req.raw, deps.security, {
      method: 'POST',
      path,
    })
  )
    return false;
  return !(
    'refused' in
    scopeDispatch(
      c,
      deps.stationControlDispatchScope,
      () => ({ kind: 'task', taskId, remote }),
      answer ? 'execute' : 'approve',
    )
  );
}
