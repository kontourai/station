/**
 * #2377 slice B: who an internal request acts for, as the station-control
 * authority guard decided it.
 *
 * The auth boundary stamps every request that presents the per-boot internal
 * token `kind:'internal'` with home-possession, which every later identity
 * decision read as "the Station operator". The guard
 * (`station-control-authority-guard.ts`) is the one place that knows what an
 * internal request actually is, so it records that here, once per request,
 * and every principal and read decision downstream consults this record
 * instead of the stamp:
 *
 * - `server`: Station's own server code inside an explicit server scope, or
 *   an exact readiness carve-out. It keeps the internal principal's
 *   authority unchanged.
 * - `caller`: a station-control tool call with a VERIFIED caller. It acts
 *   for the principal its session's ownership record names (decision 2:
 *   an agent sees what the person who owns its session could see).
 *   `boundOperator` is true only for a `bound` caller whose recorded owner is
 *   the operator; only that caller keeps the operator-wide reads (unredacted
 *   logs, other users' monitoring rows).
 * - `caller-less`: a pooled child or a bare copy of the token. It acts for
 *   no principal, so it reads nothing that is principal-scoped.
 *
 * Absent means the request is not internal, or no guard ran for it (a test
 * composition without the guard); callers keep today's behaviour then.
 */
import type { StationControlCaller } from '../tools/station-control-shared.js';

export type StationControlRequestAuthority =
  | { readonly kind: 'server' }
  | {
      readonly kind: 'caller';
      readonly caller: StationControlCaller;
      readonly boundOperator: boolean;
    }
  | { readonly kind: 'caller-less' };

const authorities = new WeakMap<Request, StationControlRequestAuthority>();

/** Written by the station-control authority guard only. */
export function bindStationControlRequestAuthority(
  request: Request,
  authority: StationControlRequestAuthority,
): void {
  authorities.set(request, Object.freeze({ ...authority }));
}

export function stationControlRequestAuthority(
  request: Request,
): StationControlRequestAuthority | undefined {
  return authorities.get(request);
}

/**
 * Whether this request is a station-control agent call whose reads are
 * scoped to its session's principal: every caller the guard bound except a
 * bound operator caller, and every caller-less request. Station's own server
 * code and requests the guard never saw are not.
 */
export function isPrincipalScopedAgentRequest(request: Request): boolean {
  const authority = authorities.get(request);
  return (
    authority?.kind === 'caller-less' ||
    (authority?.kind === 'caller' && !authority.boundOperator)
  );
}
