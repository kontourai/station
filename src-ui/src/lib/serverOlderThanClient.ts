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
} from '@kontourai/station-shared/release-version-order';
import {
  SERVICE_UPDATE_IN_FLIGHT,
  serviceUpdateProgressLine,
} from '../views/settings/coreUpdatePresentation';

export type ServerOlderOffer =
  | { kind: 'none' }
  /** The server can update itself from here, to `target`. */
  | { kind: 'update'; client: string; server: string; target: string }
  /** It cannot from here; `remedy` says how instead. */
  | { kind: 'manual'; client: string; server: string; remedy: string };

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
  if (!clientVersion || !status || facts.checkFailed) return NONE;
  const server = status.currentVersion;
  if (!server) return NONE;
  const clientInHostOrder = clientVersionInHostOrder(clientVersion);
  if (!clientInHostOrder) return NONE;
  if (compareStationReleaseVersions(clientInHostOrder, server) !== 1) {
    return NONE;
  }
  const versions = { client: clientVersion, server };
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
    return { kind: 'update', ...versions, target: status.latestVersion };
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
  | { type: 'reset' };

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
    case 'reset':
      return { phase: 'idle' };
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
          ? { ...flow, progress, unreachable: false }
          : { ...flow, unreachable: false };
      }
      // A finished record from an earlier update is not this one's outcome.
      if (!correlates(progress, flow.requestId)) {
        return { ...flow, unreachable: false };
      }
      return {
        phase: 'finished',
        scope: flow.scope,
        requestId: flow.requestId,
        outcome: progress,
      };
    }
    case 'progress-unreachable':
      return flow.phase === 'following' ? { ...flow, unreachable: true } : flow;
    case 'expired':
      return flow.phase === 'following'
        ? { phase: 'expired', scope: flow.scope, requestId: flow.requestId }
        : flow;
  }
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
  const message = `This Station server runs ${offer.server}, older than this app (${offer.client}).`;
  const occurrence = `${offer.server}<${offer.client}`;
  if (offer.kind === 'update') {
    return {
      tone: 'info',
      message,
      detail:
        'Updating downloads and verifies the release, tries it, and keeps the current version if it does not start. The server restarts during the update.',
      occurrence,
      actions: [{ kind: 'apply', label: `Update server to ${offer.target}` }],
    };
  }
  return {
    tone: 'info',
    message,
    detail: offer.remedy,
    occurrence,
    actions: [DETAILS],
  };
}
