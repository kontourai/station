/** Release-order comparison and guidance for the Updates panel's older-server notice. */
import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import {
  clientVersionInHostOrder,
  compareStationReleaseVersions,
  hostNightlyAllocation,
} from '@kontourai/station-shared/release-version-order';
import {
  SERVICE_UPDATE_IN_FLIGHT,
  serviceUpdateProgressLine,
} from '../views/settings/coreUpdatePresentation';

interface OfferVersions {
  /** The raw version strings, kept for the details line. */
  client: string;
  server: string;
  /** The same two versions in one readable form (see `readableVersions`). */
  clientLabel: string;
  serverLabel: string;
}

export type ServerOlderOffer =
  | { kind: 'none' }
  /** The server can update itself from here, to `target`. */
  | ({ kind: 'update'; target: string } & OfferVersions)
  /** It cannot from here; `remedy` says how instead. */
  | ({ kind: 'manual'; remedy: string } & OfferVersions);

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
  const [clientLabel, serverLabel] = readableVersions(
    clientInHostOrder,
    server,
  );
  const versions: OfferVersions = {
    client: clientVersion,
    server,
    clientLabel,
    serverLabel,
  };
  const manual = (remedy: string): ServerOlderOffer => ({
    kind: 'manual',
    ...versions,
    remedy,
  });

  const progress = status.serviceUpdate;
  if (progress && SERVICE_UPDATE_IN_FLIGHT.has(progress.state)) {
    return manual('An update is already under way on that server.');
  }
  if (progress?.state === 'needs-operator') {
    return manual(
      serviceUpdateProgressLine(progress, status.serverIdentity?.instanceId)
        ?.text ?? ON_HOST,
    );
  }
  if (status.selfUpdateUnavailableReason) {
    return manual(
      `It cannot be updated from here: ${status.selfUpdateUnavailableReason}.`,
    );
  }
  if (
    status.installKind === 'archive-service' &&
    status.applyMethod === 'service-update' &&
    status.releaseCheck === 'verified'
  ) {
    if (!status.updateAvailable || !status.latestVersion) {
      const ring = status.channel ? `${status.channel} ` : '';
      return manual(
        `It already runs the newest ${ring}release, so there is nothing to update it to yet.`,
      );
    }
    if (!facts.identityMatches) {
      return manual(
        'This app could not confirm which server answered. Check for server updates in Settings.',
      );
    }
    if (status.stagedUpdates) {
      return manual(
        status.serviceUpdate?.state === 'staged'
          ? `Station ${status.serviceUpdate.version} is downloaded. Restart the server into it from Updates, which lists the agent turns a restart would interrupt.`
          : 'Download the update and restart the server from Updates, which lists the agent turns a restart would interrupt.',
      );
    }
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

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Two host-order versions in one readable form, so they read side by side: a
 * Nightly as its build date ("Nightly Oct 9, build 3"), anything else as its
 * version. The release (X.Y.Z) is named only when the two differ in it, and
 * the year only when the two dates differ in it.
 */
export function readableVersions(
  left: string,
  right: string,
): [string, string] {
  const a = hostNightlyAllocation(left);
  const b = hostNightlyAllocation(right);
  const showCore = !sameRelease(left, right);
  const showYear =
    !!a && !!b && a.date.getUTCFullYear() !== b.date.getUTCFullYear();
  const label = (
    version: string,
    allocation: ReturnType<typeof hostNightlyAllocation>,
  ) => {
    if (!allocation) return version;
    const { date, build } = allocation;
    const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}${
      showYear ? `, ${date.getUTCFullYear()}` : ''
    }`;
    const core = showCore ? `${releaseCore(version)} ` : '';
    return `${core}Nightly ${day}${build > 0 ? `, build ${build}` : ''}`;
  };
  return [label(left, a), label(right, b)];
}

export function serverOlderNoticeContent(
  offer: ServerOlderOffer,
): { message: string; detail: string } | null {
  if (offer.kind === 'none') return null;
  const message = `This Station server runs ${offer.serverLabel}, which is older than this app (${offer.clientLabel}).`;
  const versions = `Server ${offer.server}, app ${offer.client}.`;
  return {
    message,
    detail:
      offer.kind === 'update'
        ? `${versions} Review the server update to ${offer.target} below. Updating downloads and verifies it, tries it, and keeps the current version if it does not start. The server restarts during the update.`
        : `${versions} ${offer.remedy}`,
  };
}
