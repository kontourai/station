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
 *   account, and what they may see is limited to that account. This is the
 *   predicate the agent-activity card already uses for "may this device
 *   read the owner's sessions" (`canReadAgentActivity`), so there is one
 *   definition, not a second one. A delegated Station or a no-read-scope
 *   device never receives approvals, pairing requests or failures. (The
 *   pre-#2586 Web Push fan-out sent them to every subscribed device.)
 * - `session-readers`: devices that can read the session by their OWN
 *   credential — the same authority the agent-activity card reads with
 *   (`canReadAgentActivity` + `pairedDevicePrincipal` +
 *   `canUserReadSession`) — plus the operator when the operator can read it.
 *   An agent notification is session content; a device that cannot open the
 *   session must not be shown its text on a lock screen.
 * - `principal`: reserved for accounts. Nothing resolves it yet, so it
 *   reaches no surface (the in-app feed still carries it) and says so once.
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
   * Every surface here belongs to one person even though their principal
   * ids differ (an unbound paired device reads as its own device identity,
   * the operator's tabs as the operator). Focus on any of them may quiet the
   * others. Set only for `owner`.
   */
  onePerson?: boolean;
}

export interface AudienceResolver {
  resolve(envelope: NotificationEnvelopeV1): AudienceResolution;
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

  return {
    resolve(envelope) {
      const audience = envelope.audience;
      if (audience.kind === 'owner') {
        const principalOf = new Map<SurfaceId, string>();
        const surfaces = new Set<SurfaceId>();
        for (const device of activeDevices()) {
          if (!isPersonalFamilyDevice(device)) continue;
          const principalId = principalOrUndefined(deps, device);
          const surface = deviceSurfaceId(device.id);
          surfaces.add(surface);
          if (principalId) principalOf.set(surface, principalId);
        }
        return {
          deviceSurfaces: surfaces,
          includesOperator: true,
          principalOf,
          operatorPrincipalId: deps.operatorPrincipalId,
          onePerson: true,
        };
      }
      if (audience.kind === 'session-readers') {
        const surfaces = new Set<SurfaceId>();
        const principalOf = new Map<SurfaceId, string>();
        for (const device of activeDevices()) {
          if (!canReadAgentActivity(device)) continue;
          const principalId = principalOrUndefined(deps, device);
          if (!principalId || !canRead(audience.sessionId, principalId))
            continue;
          const surface = deviceSurfaceId(device.id);
          surfaces.add(surface);
          principalOf.set(surface, principalId);
        }
        return {
          deviceSurfaces: surfaces,
          includesOperator: canRead(
            audience.sessionId,
            deps.operatorPrincipalId,
          ),
          principalOf,
          operatorPrincipalId: deps.operatorPrincipalId,
        };
      }
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
