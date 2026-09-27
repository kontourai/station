/**
 * Which surfaces hold a live `/api/events` stream — the stream the in-app
 * toast arrives on — keyed the way focus presence (#2585) keys its surfaces
 * (#2620).
 *
 * The notification router trusts a focused surface to quiet a person's other
 * surfaces only while that surface can actually show the in-app toast. Focus
 * alone is not enough: a tab whose event stream silently dropped still
 * heartbeats its focus, and would silence the phone while showing nothing.
 *
 * - `device:<id>`: live only while a document whose focus report is
 *   `focused` holds its own stream on that device (the connected-clients
 *   presence, keyed by device and `X-Station-Client-Session`). Focus
 *   reconciles a device's documents into one surface, so a device-wide check
 *   would let one live background tab vouch for a focused tab whose stream
 *   is dead. The local browser UI signs in with a device credential, so this
 *   is the operator's own tabs' path too.
 * - `local:<clientSessionId>`: the operator tab's own stream, keyed by the
 *   `X-Station-Client-Session` header the same document sends on its focus
 *   reports. Only the operator credential gets a local lease — the same
 *   callers the focus route accepts as `local:` reporters.
 *
 * Session ids are lowercased on both leases, as the focus route records
 * them, or the per-document match would silently miss. Every unknown reads
 * as not live, and a capacity refusal leaves a stream
 * untracked, so every gap errs toward interrupting.
 */
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { SurfaceId } from '../../services/notifications/delivery/channel.js';
import type { InAppLiveness } from '../../services/notifications/delivery/router.js';
import type { FocusPresence } from '../../services/presence/focus-presence.js';
import {
  CLIENT_SESSION_ID_PATTERN,
  type ClientConnectionLease,
  ClientConnectionPresence,
} from '../../services/ssh/client-connection-presence.js';

/** The one owner key every operator tab's lease is held under. */
const LOCAL_OPERATOR_STREAMS = 'local-operator';

export interface ClientStreamPresenceDeps {
  /** Paired-device streams; also read by the connected-clients routes. */
  devices: ClientConnectionPresence;
  identifyDevice(credential: string): { readonly id: string } | null;
  /** Which documents a device surface's focus belongs to. */
  focus: Pick<FocusPresence, 'focusedSessions'>;
  /** Operator-tab streams. Defaults to a fresh instance. */
  local?: ClientConnectionPresence;
}

export interface ClientStreamPresence {
  /** For the event route: lease this request's stream, if it is trackable. */
  connect(request: Request): ClientConnectionLease | undefined;
  inAppLiveness: InAppLiveness;
}

export function createClientStreamPresence(
  deps: ClientStreamPresenceDeps,
): ClientStreamPresence {
  const local = deps.local ?? new ClientConnectionPresence();
  return {
    connect(request) {
      const header = request.headers.get('x-station-client-session');
      if (!header || !CLIENT_SESSION_ID_PATTERN.test(header)) return undefined;
      const principal = getRuntimeAuthenticatedRequestPrincipal(request);
      // Mirrors the focus route's `local:` reporter check, and lowercases
      // the id the way that route records the surface.
      if (
        principal?.kind === 'credential' &&
        principal.authority === 'operator-credential'
      )
        return local.connect(LOCAL_OPERATOR_STREAMS, header.toLowerCase());
      if (principal?.authority !== 'device-credential') return undefined;
      const device = deps.identifyDevice(principal.credential);
      return device
        ? deps.devices.connect(device.id, header.toLowerCase())
        : undefined;
    },
    inAppLiveness: {
      isLive(surface: SurfaceId) {
        if (surface.startsWith('device:')) {
          const deviceId = surface.slice('device:'.length);
          return deps.focus
            .focusedSessions(surface)
            .some((session) => deps.devices.isConnected(deviceId, session));
        }
        if (surface.startsWith('local:'))
          return local.isConnected(
            LOCAL_OPERATOR_STREAMS,
            surface.slice('local:'.length),
          );
        return false;
      },
    },
  };
}
