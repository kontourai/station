import {
  PAIRING_SCOPE_ACCESS_MANAGE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { TelemetryChoiceCapabilities } from '@kontourai/station-contracts/product-telemetry';
import {
  isOperatorInPersonNotAgent,
  requestMayBeAnAgent,
} from './coding-authority.js';
import { requestFromPluginPane } from './plugin-pane-context.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from './runtime-request-security.js';

/**
 * Whether this request may RAISE a usage-sharing tier. `PUT /config/app`
 * refuses a raise without it (TELEMETRY_CHOICE_NOT_GRANTED), and the
 * disclosure read reports it, so both answers come from this one predicate:
 * the operator in person, or a credential holding `access:manage`, and never
 * an agent or a plugin pane.
 */
export function mayRaiseTelemetryChoice(
  request: Request,
  presentedScope: string | undefined,
): boolean {
  return (
    !requestMayBeAnAgent(request) &&
    !requestFromPluginPane(request) &&
    (isOperatorInPersonNotAgent(request) ||
      (presentedScope !== undefined &&
        pairingScopeIncludes(presentedScope, PAIRING_SCOPE_ACCESS_MANAGE)))
  );
}

/**
 * What this caller may do with the usage-sharing choice, as the server's own
 * gates will decide it: the HTTP boundary for each route (the same check
 * ingress applies), then the handler-level refusals those routes add. Agents
 * and plugin panes are refused acknowledgements and notices in the handler;
 * agents are refused every telemetry choice write in `PUT /config/app`.
 */
export function telemetryChoiceCapabilities(
  request: Request,
  security: CurrentRuntimeRequestPrincipalSecurity,
  presentedScope: string | undefined,
): TelemetryChoiceCapabilities {
  const reaches = (method: string, path: string) =>
    runtimeRequestPrincipalMayAccessHttpRoute(request, security, {
      method,
      path,
    });
  const userAction =
    !requestMayBeAnAgent(request) && !requestFromPluginPane(request);
  const lower = !requestMayBeAnAgent(request) && reaches('PUT', '/config/app');
  return {
    acknowledge:
      userAction &&
      reaches('POST', '/api/usage-telemetry/disclosure/acknowledgements'),
    recordNotice:
      userAction && reaches('POST', '/api/usage-telemetry/lite-notices'),
    lower,
    raise: lower && mayRaiseTelemetryChoice(request, presentedScope),
  };
}
