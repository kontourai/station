/** Release-order comparison and guidance for the Updates panel's older-server notice. */
import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import {
  clientVersionInHostOrder,
  compareStationReleaseVersions,
} from '@kontourai/station-shared/release-version-order';
import {
  isArchiveInstall,
  SERVICE_UPDATE_IN_FLIGHT,
} from '../views/settings/coreUpdatePresentation';

interface OfferVersions {
  client: string;
  server: string;
}

export type ServerOlderOffer =
  | { kind: 'none' }
  /** The server can update itself from here, to `target`. */
  | ({ kind: 'update'; target: string } & OfferVersions)
  /**
   * It cannot from here; `remedy` says how instead, or is null when the
   * Updates server section already shows the way (its progress, its
   * refusal, or its Download and Restart actions).
   */
  | ({ kind: 'manual'; remedy: string | null } & OfferVersions);

const NONE: ServerOlderOffer = { kind: 'none' };
const ON_HOST = 'Run "station upgrade" on its host to update it.';

export interface ServerOlderFacts {
  /** This client's stamped release version; null for dev and local builds. */
  clientVersion: string | null;
  /** The connected server's own update status, once it answered. */
  status: CoreUpdateStatus | undefined;
  /** The latest check failed: cached facts no longer speak for the server. */
  checkFailed: boolean;
  /**
   * The selection this view checked is still current and its server still
   * answers. Cached facts from a superseded or unreachable server are
   * history and offer nothing.
   */
  current: boolean;
  /**
   * The answering server is the one this view correlated (same instance,
   * boot and build). An apply is offered only to a server that is.
   */
  identityMatches: boolean;
}

/**
 * Compares real version identities only: this client's release version in
 * the host stream's order against the version the server reports running.
 * Anything that cannot be ordered — a dev build, a server that states no
 * version (source checkouts, older servers), another ring's prerelease of
 * the same release — says nothing.
 */
export function deriveServerOlderOffer(
  facts: ServerOlderFacts,
): ServerOlderOffer {
  const { clientVersion, status } = facts;
  if (!clientVersion || !status || facts.checkFailed || !facts.current) {
    return NONE;
  }
  const server = status.currentVersion;
  if (!server) return NONE;
  const clientInHostOrder = clientVersionInHostOrder(clientVersion);
  if (!clientInHostOrder) return NONE;
  if (compareStationReleaseVersions(clientInHostOrder, server) !== 1) {
    return NONE;
  }
  // A bare X.Y.Z client against a prerelease of the same X.Y.Z says
  // nothing. The bare stamp may be a ring build that lost its ring (an
  // internal or older iOS build stamped with Apple's marketing version), so
  // it cannot tell which is newer. This deliberately also silences a genuine
  // stable 0.1.12 desktop or Android client against a 0.1.12-preview.N
  // server: that server tracks another ring and cannot self-update to the
  // stable release anyway.
  if (
    releaseCore(clientInHostOrder) === clientInHostOrder &&
    sameRelease(clientInHostOrder, server)
  ) {
    return NONE;
  }
  const versions: OfferVersions = { client: clientVersion, server };
  const manual = (remedy: string | null): ServerOlderOffer => ({
    kind: 'manual',
    ...versions,
    remedy,
  });

  const progress = status.serviceUpdate;
  // The section shows an update under way, and one that needs an operator,
  // in its own progress line.
  if (
    progress &&
    (SERVICE_UPDATE_IN_FLIGHT.has(progress.state) ||
      progress.state === 'needs-operator')
  ) {
    return manual(null);
  }
  if (status.selfUpdateUnavailableReason) {
    // The section states the same refusal beside an available update.
    const sectionStatesRefusal =
      status.updateAvailable &&
      (status.applyMethod === 'git-pull' || isArchiveInstall(status));
    return manual(
      sectionStatesRefusal
        ? null
        : `It cannot be updated from here: ${status.selfUpdateUnavailableReason}.`,
    );
  }
  if (
    status.installKind === 'archive-service' &&
    status.applyMethod === 'service-update' &&
    status.releaseCheck === 'verified'
  ) {
    if (!status.updateAvailable || !status.latestVersion) {
      const ring = status.channel ? `${status.channel} ` : '';
      return manual(`No newer ${ring}server release yet.`);
    }
    if (!facts.identityMatches) {
      return manual(
        'Could not confirm which server answered. Check for server updates.',
      );
    }
    // Download, then Restart, are the section's own actions.
    if (status.stagedUpdates) return manual(null);
    return {
      kind: 'update',
      ...versions,
      target: status.latestVersion,
    };
  }
  if (
    status.releaseCheck === 'unreachable' ||
    status.releaseCheck === 'unverified' ||
    status.releaseCheck === 'not-recorded'
  ) {
    return manual(status.message ? `${status.message} ${ON_HOST}` : ON_HOST);
  }
  return manual(ON_HOST);
}

const RELEASE_CORE =
  /^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-|$)/;

function releaseCore(version: string): string | null {
  return RELEASE_CORE.exec(version)?.[1] ?? null;
}

/** Same X.Y.Z, parsed: never a prefix or substring match. */
function sameRelease(left: string, right: string): boolean {
  const a = releaseCore(left);
  return a !== null && a === releaseCore(right);
}

export function serverOlderNoticeContent(
  offer: ServerOlderOffer,
): { message: string; detail?: string } | null {
  if (offer.kind === 'none') return null;
  // The server's version is in its section header. The app's is named here:
  // a web client on another origin has no app section, and the desktop one
  // hides its version while an app update downloads. An offered update is
  // the section's own button, so only a remedy the section lacks is added.
  return {
    message: `Server is older than this app (${offer.client}).`,
    detail: offer.kind === 'manual' ? (offer.remedy ?? undefined) : undefined,
  };
}
