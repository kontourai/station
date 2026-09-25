/**
 * AudienceResolver (#2582 §1b/§3, #2586): the single place an envelope's
 * audience turns into the surfaces allowed to be interrupted by it. Future
 * accounts change this file, not the router or the channels.
 *
 * - `owner`: the operator's local surfaces plus the personal family's
 *   devices — the same membership `DevicePairingService` uses for shared
 *   personal conversations (`isPersonalConversationMember`, #1958): an
 *   active person's device (not a delegation grant, not pending enrollment)
 *   holding `orchestration:read`, unbound or bound to a tailnet person.
 *   Account-bound devices are out: their requests read as that deployment
 *   account, limited to that account. This is the agent-activity card's
 *   read eligibility (`canReadAgentActivity`) — one definition, not two.
 * - `session-readers`: devices that can read the session by their OWN
 *   credential — the same authority the agent-activity card reads with
 *   (`canReadAgentActivity` + `pairedDevicePrincipal` +
 *   `canUserReadSession`) — plus the operator when the operator can read it.
 *   An agent notification is session content; a device that cannot open the
 *   session must not be shown its text on a lock screen.
 * - `principal`: reserved for accounts. Nothing resolves it yet, so it
 *   reaches no surface (the in-app feed still carries it) and says so once.
 *
 * Whatever the audience, a record that NAMES a session (legacy approvals
 * and turn completions carry `metadata.sessionId`; an envelope may name one
 * too — `notificationSessionIdentity`) reaches only surfaces whose principal
 * can read that session, and local surfaces only if the operator can. The
 * in-app list applies the same check to the same record; delivery must not
 * show a lock screen what the inbox would hide.
 *
 * Fail closed: a device whose read check throws is left out.
 */
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import { errorMessage } from '../../../utils/error-message.js';
import { canReadAgentActivity } from '../agent-activity-eligibility.js';
import { deviceSurfaceId, type SurfaceId } from './channel.js';

export interface AudienceResolution {
  /** Paired-device surfaces in the audience. */
  deviceSurfaces: ReadonlySet<SurfaceId>;
  /** Whether the operator — and so every `local:` surface — is in it. */
  includesOperator: boolean;
  /**
   * The principal each device surface reads as, and the operator's (for
   * `local:` surfaces). Focus only quiets surfaces of the principal that
   * reported it; a surface missing here is never quieted.
   */
  principalOf?: ReadonlyMap<SurfaceId, string>;
  operatorPrincipalId?: string;
  /**
   * Principals that are the owner themselves even though their ids differ:
   * the operator (local tabs, the desktop host), each unbound paired device
   * (it reads as its own device identity), and any device whose binding
   * resolves to the operator. Focus on any of these may quiet the others.
   * A tailnet-bound device of another person (a housemate) is NOT here: it
   * is its own person for focus, so their focus never quiets the owner.
   */
  ownerPrincipals?: ReadonlySet<string>;
}

export interface AudienceResolver {
  /**
   * `sessionId`: the session the record names (metadata for legacy
   * producers, else the envelope's — `notificationSessionIdentity`). When
   * present, every surface must also be able to read that session,
   * whatever the audience: the in-app list filters the same record the
   * same way.
   */
  resolve(
    envelope: NotificationEnvelopeV1,
    context?: { sessionId?: string },
  ): AudienceResolution;
}

export interface PairingAudienceResolverDeps {
  listDevices(): PairedDevice[];
  /** The principal a request carrying this device's credential reads as. */
  devicePrincipalId(device: PairedDevice): string;
  operatorPrincipalId: string;
  canPrincipalReadSession(sessionId: string, principalId: string): boolean;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}

/**
 * A device of the owner's personal family. Same criteria as
 * `DevicePairingService.isPersonalConversationMember` for a current member,
 * minus account-bound devices; identical to the agent-activity card's
 * read eligibility, which is where it is defined.
 */
export function isPersonalFamilyDevice(device: PairedDevice): boolean {
  return canReadAgentActivity(device);
}

const NO_ONE: AudienceResolution = {
  deviceSurfaces: new Set(),
  includesOperator: false,
};

function principalOrUndefined(
  deps: PairingAudienceResolverDeps,
  device: PairedDevice,
): string | undefined {
  try {
    return deps.devicePrincipalId(device);
  } catch (error) {
    deps.logger.warn(
      'notification-delivery: could not resolve a device principal',
      {
        error: errorMessage(error),
      },
    );
    return undefined;
  }
}

export function createPairingAudienceResolver(
  deps: PairingAudienceResolverDeps,
): AudienceResolver {
  let warnedPrincipal = false;
  const activeDevices = () =>
    deps.listDevices().filter((device) => device.revokedAt === null);

  const canRead = (sessionId: string, principalId: string): boolean => {
    try {
      return deps.canPrincipalReadSession(sessionId, principalId) === true;
    } catch (error) {
      deps.logger.warn('notification-delivery: session read check failed', {
        error: errorMessage(error),
      });
      return false;
    }
  };

  /** Family devices whose principal passes every named session's check. */
  const readers = (sessionIds: readonly string[]) => {
    const surfaces = new Set<SurfaceId>();
    const principalOf = new Map<SurfaceId, string>();
    const ownerPrincipals = new Set<string>([deps.operatorPrincipalId]);
    for (const device of activeDevices()) {
      if (!isPersonalFamilyDevice(device)) continue;
      const principalId = principalOrUndefined(deps, device);
      if (!principalId) continue;
      if (!sessionIds.every((sessionId) => canRead(sessionId, principalId)))
        continue;
      const surface = deviceSurfaceId(device.id);
      surfaces.add(surface);
      principalOf.set(surface, principalId);
      if (
        device.principalBinding === undefined ||
        principalId === deps.operatorPrincipalId
      )
        ownerPrincipals.add(principalId);
    }
    return {
      deviceSurfaces: surfaces,
      includesOperator: sessionIds.every((sessionId) =>
        canRead(sessionId, deps.operatorPrincipalId),
      ),
      principalOf,
      operatorPrincipalId: deps.operatorPrincipalId,
      ownerPrincipals,
    };
  };

  return {
    resolve(envelope, context = {}) {
      const audience = envelope.audience;
      const named = context.sessionId === undefined ? [] : [context.sessionId];
      if (audience.kind === 'owner') return readers(named);
      if (audience.kind === 'session-readers')
        return readers([...new Set([audience.sessionId, ...named])]);
      if (!warnedPrincipal) {
        warnedPrincipal = true;
        deps.logger.warn(
          'notification-delivery: principal audiences are not supported yet; delivering in-app only',
        );
      }
      return NO_ONE;
    },
  };
}
