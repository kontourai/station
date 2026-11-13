import {
  type ClientOriginSurface,
  type ClientReportedOrigin,
} from '@kontourai/station-contracts/client-origin';
import { requestMayBeAnAgent } from './coding-authority.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  resolveClientOriginForRequest,
} from './runtime-request-security.js';

/**
 * #4827: whether a request carries text a person typed into one of Station's
 * own clients. This is the one positive test behind `turn.started`'s
 * `authoredBy: 'person'`, which the approval guardian reads as the person's
 * own words. Anything it does not accept is not the person's (fail closed).
 *
 * All of these must hold:
 *
 * - The caller is a person's credential: the operator's credential or
 *   passkey session, or a paired device of kind `device`. A peer Station's
 *   `delegation` device, Station's internal principal, and an unknown caller
 *   are not.
 * - The request is not one an agent may have made (`requestMayBeAnAgent`:
 *   the internal principal, or Station's agent-tool origin marker, as an
 *   agent running `station chat` through Station's tools sends).
 * - The client reports a composer surface (`web`, `desktop`, `mobile`). The
 *   report is the client's own claim, so it is used only to narrow: the CLI
 *   (`cli`), MCP clients (`mcp`) and anything unreported (`unknown`) are
 *   excluded, because a script or an agent drives those as easily as a
 *   person. A client that lies here already holds a person's credential.
 *
 * It says nothing about the route. Only the routes that carry a composer's
 * send call it, and only those may set the marker; see
 * `PERSON_AUTHORED_TURN_INGRESS`.
 */
const PERSON_COMPOSER_SURFACES: readonly ClientOriginSurface[] = [
  'web',
  'desktop',
  'mobile',
];

export function personTypedRequest(
  request: Request,
  inboundDeviceKind?: 'device' | 'delegation',
): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (principal?.kind !== 'credential') return false;
  if (requestMayBeAnAgent(request)) return false;
  if (
    inboundDeviceKind === 'delegation' ||
    principal.deviceKind === 'delegation'
  )
    return false;
  const personCredential =
    principal.authority === 'operator-credential' ||
    principal.authority === 'operator-session' ||
    (principal.authority === 'device-credential' &&
      (principal.deviceKind === 'device' || inboundDeviceKind === 'device'));
  if (!personCredential) return false;
  return isPersonComposerSurface(
    resolveClientOriginForRequest(request).reported,
  );
}

function isPersonComposerSurface(reported: ClientReportedOrigin): boolean {
  return PERSON_COMPOSER_SURFACES.includes(reported.surface);
}
