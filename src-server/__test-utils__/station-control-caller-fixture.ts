/**
 * #2377 slice A: run station-control tool handlers as a verified caller.
 *
 * `StationControlToolRegistry` refuses a mutating tool before it calls Station
 * unless the call carries a caller the authority table allows. Tests that
 * characterize a tool's REST plumbing (which route, which body, how an error
 * envelope is surfaced) call the registered handler directly, outside any MCP
 * transport, so they have no caller. This runs each handler inside the same
 * verified-caller context the HTTP MCP route and in-process delivery install,
 * resolving to the caller given — a bound operator by default, the one caller
 * every non-person-only tool accepts.
 *
 * The context carries no forwarded token, so the tool's requests are
 * byte-identical to before (no caller-token header). What the table refuses,
 * and for whom, is proved by the authority tests, not here.
 */

import { STATION_CONTROL_OPERATOR_PRINCIPAL_ID } from '../tools/station-control-policy.js';
import {
  type StationControlCaller,
  stationControlCallerPrincipal,
  withStationControlCallerContext,
} from '../tools/station-control-shared.js';

const BOUND_OPERATOR_CALLER: StationControlCaller = Object.freeze({
  sessionId: 'fixture-operator-session',
  assurance: 'bound',
  principal: stationControlCallerPrincipal(
    STATION_CONTROL_OPERATOR_PRINCIPAL_ID,
    'session-owner',
  ),
  localProjectId: 'fixture-project',
  projectIdSource: 'session-record',
});

export function asStationControlCaller<
  Handler extends (...args: any[]) => unknown,
>(
  handlers: Record<string, Handler>,
  caller: StationControlCaller = BOUND_OPERATOR_CALLER,
): Record<string, Handler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      ((...args: unknown[]) =>
        withStationControlCallerContext(
          { token: undefined, resolve: () => caller },
          () => handler(...args),
        )) as Handler,
    ]),
  );
}
