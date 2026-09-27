/**
 * #2377 slice C2a: dispatch is scoped at the dispatch ROUTE, the top of the
 * dispatch hop (the constraint recorded on the issue). A route handler runs
 * its later hops (SSH connect, a peer credential, Agent and Connection
 * reads) as Station's own server code, which the central guard lets through
 * whoever triggered the dispatch; so the scope is decided here, after the
 * route knows what the request aims at and before anything runs.
 *
 * Only a station-control tool call with a verified caller is decided: the
 * operator's UI, paired devices and Station's own server code keep their
 * own rules, and a caller-less internal request never reaches a dispatch
 * route (the guard refuses it). The rule is the one C1's steer and adopt
 * use (`stationControlScopeRefusal`).
 */
import type { Context } from 'hono';
import type {
  StationControlDispatchScope,
  StationControlDispatchTargetRef,
  StationControlProjectAction,
} from '../../runtime/mcp/station-control-dispatch-scope.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  stationControlRefusalBody,
  stationControlScopeRefusal,
} from '../../tools/station-control-policy.js';

/** A reference to what the request aims at, given the caller's owner. */
export type DispatchTargetFor = (
  ownerId: string | undefined,
) => StationControlDispatchTargetRef | undefined;

/**
 * A 403 with the typed refusal when a station-control caller aims outside
 * its scope; `undefined` otherwise. `scope` absent (a composition without
 * it) refuses every station-control caller: a dispatch nobody scoped is not
 * allowed by default.
 */
export function refuseOutOfScopeDispatch(
  c: Context,
  scope: StationControlDispatchScope | undefined,
  targetFor: DispatchTargetFor,
  /** The Project action the owner needs. */
  action: StationControlProjectAction = 'execute',
): Response | undefined {
  const authority = stationControlRequestAuthority(c.req.raw);
  if (authority?.kind !== 'caller') return undefined;
  const caller = authority.caller;
  const ref = targetFor(
    caller.principal?.elevationEligible ? caller.principal.id : undefined,
  );
  const target = ref ? scope?.target(ref, action) : undefined;
  const refusal = stationControlScopeRefusal(caller, target);
  return refusal ? c.json(stationControlRefusalBody(refusal), 403) : undefined;
}

/** Whether an environment reference names another Station. */
export function namesAnotherStation(
  environment: { readonly kind: string } | undefined,
): boolean {
  return environment !== undefined && environment.kind !== 'current';
}
