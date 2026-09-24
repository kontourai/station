/**
 * Who a Browser request may be from (#90 review S4, S7): the two predicates
 * the browser routes gate on, named and exported so they are tested against
 * the real runtime principal stamps rather than re-derived at each mount.
 *
 * The boundary they draw, stated plainly: Station's internal token is a
 * per-boot, home-possession credential. Any same-user process with a shell
 * can read it (an agent's own environment included), so it proves "a
 * process of this user on this machine", never "the operator in person".
 */
import { isAgentOriginatedRequest } from '../../runtime/mcp/station-control-caller.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  resolveInboundDeviceKindForRequest,
} from '../../security/runtime-request-security.js';

/**
 * Whether the runtime boundary accepted this request as Station's own
 * internal principal. The browser tools' REST side answers ONLY these; the
 * human Browser pane routes refuse them.
 */
export function isStationInternalRequest(request: Request): boolean {
  return getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal';
}

/**
 * Whether a request may be an agent's rather than a person's: Station's
 * internal principal, an agent-tool marker (presence only restricts), or a
 * delegation device. Such a request may never change a permission that
 * constrains agents (D4).
 */
export function mayBeAgentRequest(
  request: Request,
  identifyDevice: (credential: string) => { kind?: string } | null | undefined,
): boolean {
  return (
    isStationInternalRequest(request) ||
    isAgentOriginatedRequest(request) ||
    resolveInboundDeviceKindForRequest(request, identifyDevice) === 'delegation'
  );
}
