/**
 * "This app is newer than the Station server it reaches" (#2675): when to say
 * it, what the reader can do about it, and the one-click update's progress.
 *
 * Pure: the launch check (components/ServerOlderLaunchCheck.tsx) supplies the
 * facts and turns the result into a banner.
 */
import type { ServiceUpdateProgress } from '@kontourai/station-contracts/system-status';
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
  /** Names the server: its instance, else its address. */
  serverKey: string;
}

export type ServerOlderOffer =
  | { kind: 'none' }
  /** The server can update itself from here, to `target`. */
  | ({ kind: 'update'; target: string; targetLabel: string } & OfferVersions)
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
  /** Names the server (instance id, else address) for the dismissal key. */
  serverKey: string;
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
    serverKey: facts.serverKey,
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
    // #3851: a server that downloads and restarts as separate steps is
    // updated from Settings, where the restart is confirmed against the
    // agent turns it would interrupt. The banner never restarts it.
    if (status.stagedUpdates) {
      return manual(
        status.serviceUpdate?.state === 'staged'
          ? `Station ${status.serviceUpdate.version} is downloaded. Restart the server into it from Settings, which lists the agent turns a restart would interrupt.`
          : 'Download the update and restart the server from Settings, which lists the agent turns a restart would interrupt.',
      );
    }
    return {
      kind: 'update',
      ...versions,
      target: status.latestVersion,
      targetLabel: readableVersions(status.latestVersion, server)[0],
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

/**
 * The one-click update's lifecycle, bound to the connection it started on
 * (`scope`). A service update restarts the server, so the scope is the
 * connection, not the server's boot.
 */
export type ServerUpdateFlow =
  | { phase: 'idle' }
  | { phase: 'requesting'; scope: string }
  | {
      phase: 'following';
      scope: string;
      requestId: string;
      /** Latest progress for this request, while it is unfinished. */
      progress: ServiceUpdateProgress | null;
      /** The progress read failed: the server is restarting or gone. */
      unreachable: boolean;
      /** Progress reads failed in a row, for backing off the poll. */
      misses: number;
    }
  | {
      phase: 'finished';
      scope: string;
      requestId: string;
      outcome: ServiceUpdateProgress;
    }
  | { phase: 'failed'; scope: string; message: string }
  | { phase: 'expired'; scope: string; requestId: string };

export type ServerUpdateEvent =
  | { type: 'apply'; scope: string }
  | { type: 'accepted'; requestId: string }
  | { type: 'refused'; message: string }
  | { type: 'progress'; progress: ServiceUpdateProgress }
  | { type: 'progress-unreachable' }
  | { type: 'expired' }
  /** The reader dismissed the banner. Only a finished story closes. */
  | { type: 'dismiss' };

function correlates(
  progress: ServiceUpdateProgress,
  requestId: string,
): boolean {
  return 'requestId' in progress && progress.requestId === requestId;
}

export function serverUpdateFlowReducer(
  flow: ServerUpdateFlow,
  event: ServerUpdateEvent,
): ServerUpdateFlow {
  switch (event.type) {
    case 'dismiss':
      // Dismissing a running update hides the banner; it does not forget
      // the update, so the stale offer cannot come back mid-update.
      return flow.phase === 'requesting' || flow.phase === 'following'
        ? flow
        : { phase: 'idle' };
    case 'apply':
      // One request at a time: a second click while one is open is ignored.
      return flow.phase === 'requesting' || flow.phase === 'following'
        ? flow
        : { phase: 'requesting', scope: event.scope };
    case 'accepted':
      return flow.phase === 'requesting'
        ? {
            phase: 'following',
            scope: flow.scope,
            requestId: event.requestId,
            progress: null,
            unreachable: false,
            misses: 0,
          }
        : flow;
    case 'refused':
      return flow.phase === 'requesting'
        ? { phase: 'failed', scope: flow.scope, message: event.message }
        : flow;
    case 'progress': {
      if (flow.phase !== 'following') return flow;
      const { progress } = event;
      if (SERVICE_UPDATE_IN_FLIGHT.has(progress.state)) {
        // An `updating` record with no request id is the launcher's own and
        // the only update running; any other unfinished record must name
        // this request to speak for it.
        const ours =
          correlates(progress, flow.requestId) ||
          (progress.state === 'updating' && progress.requestId === null);
        return ours
          ? { ...flow, progress, unreachable: false, misses: 0 }
          : { ...flow, unreachable: false, misses: 0 };
      }
      // A finished record from an earlier update is not this one's outcome.
      if (!correlates(progress, flow.requestId)) {
        return { ...flow, unreachable: false, misses: 0 };
      }
      return {
        phase: 'finished',
        scope: flow.scope,
        requestId: flow.requestId,
        outcome: progress,
      };
    }
    case 'progress-unreachable':
      return flow.phase === 'following'
        ? { ...flow, unreachable: true, misses: flow.misses + 1 }
        : flow;
    case 'expired':
      return flow.phase === 'following'
        ? { phase: 'expired', scope: flow.scope, requestId: flow.requestId }
        : flow;
  }
}

const PROGRESS_POLL_MS = 2_000;
const PROGRESS_POLL_MAX_MS = 30_000;

/**
 * How often to read the update's progress: every 2 s while the server
 * answers, doubling per failed read up to 30 s while it restarts.
 */
export function progressPollInterval(flow: ServerUpdateFlow): number | false {
  if (flow.phase !== 'following') return false;
  return Math.min(PROGRESS_POLL_MS * 2 ** flow.misses, PROGRESS_POLL_MAX_MS);
}

export type ServerOlderAction = 'apply' | 'details';

export interface ServerOlderBannerContent {
  tone: 'info' | 'warning' | 'error';
  message: string;
  detail?: string;
  /** Names this banner's condition; a dismissal holds until it changes. */
  occurrence: string;
  actions: Array<{ kind: ServerOlderAction; label: string }>;
}

const DETAILS = { kind: 'details', label: 'Server update details' } as const;

/**
 * What the banner says. An update this banner started speaks first, through
 * to its outcome; otherwise the offer does. Null means no banner.
 */
export function serverOlderBannerContent(
  offer: ServerOlderOffer,
  flow: ServerUpdateFlow,
  instance?: string,
): ServerOlderBannerContent | null {
  switch (flow.phase) {
    case 'requesting':
      return {
        tone: 'info',
        message: 'Requesting the server update…',
        occurrence: `requesting:${flow.scope}`,
        actions: [],
      };
    case 'following': {
      const line = flow.unreachable
        ? 'The server is restarting. Reconnecting…'
        : flow.progress
          ? (serviceUpdateProgressLine(flow.progress, instance)?.text ??
            'Updating the server…')
          : 'Update requested. Waiting for the Station service to start it…';
      return {
        tone: 'info',
        message: line,
        occurrence: `following:${flow.requestId}`,
        actions: [],
      };
    }
    case 'finished': {
      const line = serviceUpdateProgressLine(flow.outcome, instance);
      const tone =
        line?.tone === 'error'
          ? 'error'
          : line?.tone === 'warning' || flow.outcome.state !== 'committed'
            ? 'warning'
            : 'info';
      return {
        tone,
        message: line?.text ?? 'The server update finished.',
        occurrence: `finished:${flow.requestId}`,
        actions: flow.outcome.state === 'committed' ? [] : [DETAILS],
      };
    }
    case 'failed':
      return {
        tone: 'error',
        message: `The server update could not be started: ${flow.message}`,
        occurrence: `failed:${flow.scope}:${flow.message}`,
        actions: [DETAILS],
      };
    case 'expired':
      return {
        tone: 'warning',
        message:
          'Stopped following the server update without reading its outcome.',
        detail: `See it on the host with "station service status --instance=${instance ?? '<instance>'}", then check for server updates in Settings.`,
        occurrence: `expired:${flow.requestId}`,
        actions: [DETAILS],
      };
    case 'idle':
      break;
  }
  if (offer.kind === 'none') return null;
  const message = `This Station server runs ${offer.serverLabel}, which is older than this app (${offer.clientLabel}).`;
  const versions = `Server ${offer.server}, app ${offer.client}.`;
  // Names the server too: dismissing it for one server must not hide it for
  // another that runs the same version.
  const occurrence = `${offer.serverKey}\u0000${offer.server}<${offer.client}`;
  if (offer.kind === 'update') {
    return {
      tone: 'info',
      message,
      detail: `${versions} Updating downloads and verifies ${offer.target}, tries it, and keeps the current version if it does not start. The server restarts during the update.`,
      occurrence,
      actions: [
        { kind: 'apply', label: `Update server to ${offer.targetLabel}` },
      ],
    };
  }
  return {
    tone: 'info',
    message,
    detail: `${versions} ${offer.remedy}`,
    occurrence,
    actions: [DETAILS],
  };
}
