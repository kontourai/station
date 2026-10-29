import { realpathSync } from 'node:fs';
import type {
  ServiceUpdateIntent,
  ServiceUpdateProgress,
} from '@kontourai/station-contracts/system-status';
import {
  type ArchiveInstallState,
  acceptedReleasePath,
  compareStationReleaseVersions,
  compareWithAcceptedRelease,
  readAcceptedRelease,
  readArchiveInstallState,
} from '@kontourai/station-shared/prebuilt-archive';
import {
  isPlainCanonicalUrl,
  type ReleaseManifestPayload,
  verifyReleaseManifest,
} from '@kontourai/station-shared/release-manifest';
import {
  readServiceLauncherContext,
  readServiceUpdateProgress,
  SERVICE_LAUNCHER_PROTOCOL,
  ServiceUpdateAlreadyRequestedError,
  writeServiceUpdateRequest,
} from '@kontourai/station-shared/service-launcher-protocol';
// The pinned signing keys install.sh embeds (generated from this same file by
// scripts/install-script-generated.mjs). esbuild inlines the JSON into the
// server bundle, so a packaged server carries the table it was built with.
import PINNED_RELEASE_MANIFEST_KEYS from '../../../config/release-manifest-keys.json' with {
  type: 'json',
};
import { errorMessage } from '../schemas/schemas.js';
import type { InstallProvenance } from './install-provenance.js';

type ArchiveProvenance = Extract<InstallProvenance, { installKind: 'archive' }>;

/**
 * How the server may update a prebuilt archive (#2675 slice D3):
 *
 * - `service-update`: the fixed service launcher supervises this very server
 *   (its context names this install and this version), so an apply queues an
 *   update request the launcher's child stages and the launcher trials.
 * - `station-upgrade`: install.sh installed this archive but no launcher runs
 *   it; the host updates it with `station upgrade`.
 * - `reinstall`: an archive install.sh does not own; nothing here can update
 *   it in place.
 */
export type ArchiveApplyMethod =
  | 'service-update'
  | 'station-upgrade'
  | 'reinstall';

/**
 * Whether the server's release check could say anything:
 * - `verified`: the install's signed manifest was fetched and verified
 *   against the pinned keys for this install's ring.
 * - `unreachable`: fetching it failed (network, HTTP status, size bound).
 * - `unverified`: it arrived but is not a manifest this install trusts.
 * - `not-recorded`: the install records no public manifest to check.
 */
export type ArchiveReleaseCheck =
  | 'verified'
  | 'unreachable'
  | 'unverified'
  | 'not-recorded';

export interface ArchiveUpdateOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * The reader knows `staged` (#3851); see `readServiceUpdateProgress`.
   * Defaults to true; the legacy GET routes pass the client's opt-in.
   */
  includeStaged?: boolean;
  fetchFn?: typeof fetch;
  /** The pinned signing-key table; tests pass their own. */
  pinnedKeys?: unknown;
  platform?: string;
  arch?: string;
}

/**
 * The launcher-supervised case, proved rather than assumed: the launcher's
 * context reaches only the server its own child supervises (lifecycle.ts
 * passes it with the supervisor PID and every other child environment drops
 * it), and it must name this install and this version. A request written for
 * an install whose launcher does not run this server would update some other
 * process.
 */
function isLauncherSupervised(
  provenance: ArchiveProvenance,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const context = readServiceLauncherContext(env);
  if (!context || !provenance.installRoot) return false;
  if (context.version !== provenance.version) return false;
  try {
    return (
      realpathSync(context.installRoot) === realpathSync(provenance.installRoot)
    );
  } catch {
    return false;
  }
}

export function archiveApplyMethod(
  provenance: ArchiveProvenance,
  env?: NodeJS.ProcessEnv,
): ArchiveApplyMethod {
  if (!provenance.installRoot) return 'reinstall';
  return isLauncherSupervised(provenance, env)
    ? 'service-update'
    : 'station-upgrade';
}

const UPGRADE_ON_HOST =
  'update it on the host with "station upgrade" (a Station service switches to the new version when it restarts)';

/** Why an apply is refused for each method but `service-update`. */
function archiveApplyRefusal(
  method: Exclude<ArchiveApplyMethod, 'service-update'>,
): string {
  return method === 'reinstall'
    ? 'this server runs from a Station release archive that the Station installer did not install, so it cannot update itself; reinstall it with the Station installer (install.sh)'
    : `this server is not run by the Station service's launcher, so it cannot update itself; ${UPGRADE_ON_HOST}`;
}

/**
 * The manifest body bound. A signed manifest is a few KiB; the cap is read
 * one byte past and refused, never truncated.
 */
const MANIFEST_MAX_BYTES = 1024 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 15_000;
/**
 * GitHub serves every release asset through a redirect to its asset host, so
 * a check that refuses redirects can never reach a real release. Hops are
 * followed by hand so each one must stay https; the count is bounded, and one
 * more than this is refused. The signature, not the path, is what vouches for
 * the bytes.
 */
const MANIFEST_MAX_REDIRECTS = 5;

class ReleaseCheckError extends Error {
  constructor(
    readonly check: 'unreachable' | 'unverified',
    message: string,
  ) {
    super(message);
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MANIFEST_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ReleaseCheckError(
        'unreachable',
        `the release manifest exceeds ${MANIFEST_MAX_BYTES} bytes`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches `manifestUrl` and verifies it with the shared verifier against the
 * pinned keys for `ring`: the same checks install.sh makes before it stages
 * anything, so "available" here is a version the service can install.
 */
async function fetchVerifiedReleaseManifest(
  manifestUrl: string,
  ring: string,
  options: ArchiveUpdateOptions = {},
): Promise<ReleaseManifestPayload> {
  if (!isPlainCanonicalUrl(manifestUrl, ['https:'])) {
    throw new ReleaseCheckError(
      'unverified',
      'the recorded release manifest URL is not a plain https URL',
    );
  }
  const fetchFn = options.fetchFn ?? fetch;
  const signal = AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS);
  let url = manifestUrl;
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    try {
      response = await fetchFn(url, {
        signal,
        headers: { accept: 'application/json' },
        redirect: 'manual',
      });
    } catch (error) {
      throw new ReleaseCheckError('unreachable', errorMessage(error));
    }
    if (response.status < 300 || response.status > 399) break;
    // Release the hop's connection; only the final response is read.
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get('location');
    if (!location)
      throw new ReleaseCheckError(
        'unreachable',
        `the release manifest request returned HTTP ${response.status} without a location`,
      );
    if (hop >= MANIFEST_MAX_REDIRECTS)
      throw new ReleaseCheckError(
        'unreachable',
        `the release manifest request redirected more than ${MANIFEST_MAX_REDIRECTS} times`,
      );
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new ReleaseCheckError(
        'unverified',
        'the release manifest redirect is not a valid URL',
      );
    }
    if (next.protocol !== 'https:')
      throw new ReleaseCheckError(
        'unverified',
        'the release manifest redirect leaves https',
      );
    url = next.href;
  }
  if (!response.ok) {
    throw new ReleaseCheckError(
      'unreachable',
      `the release manifest request returned HTTP ${response.status}`,
    );
  }
  const text = await readBoundedBody(response);
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new ReleaseCheckError(
      'unverified',
      'the release manifest is not JSON',
    );
  }
  try {
    return verifyReleaseManifest(
      envelope,
      options.pinnedKeys ?? PINNED_RELEASE_MANIFEST_KEYS,
      { expectedChannel: ring },
    );
  } catch (error) {
    throw new ReleaseCheckError('unverified', errorMessage(error));
  }
}

/**
 * Why a verified manifest offering `version` is stale for this install root
 * (the installer's own rule, `readAcceptedRelease`), or null when it is not.
 */
function acceptedReleaseRefusal(
  installRoot: string,
  ring: string,
  version: string,
): { message: string; technicalDetail: string } | null {
  const path = acceptedReleasePath(installRoot);
  const mark = readAcceptedRelease(installRoot, ring);
  if (mark.state === 'absent') return null;
  if (mark.state === 'invalid')
    return {
      message:
        "This install's record of the newest release it accepted is unreadable, so no update is offered. On the host, fix its owner and permissions or remove it, then check again.",
      technicalDetail: `${path} is not a private file of this user holding a ${ring} release record`,
    };
  const relation = compareWithAcceptedRelease(ring, version, mark.version);
  if (relation === 'not-older') return null;
  return relation === 'older'
    ? {
        message: `The ${ring} release manifest offers ${version}, older than ${mark.version} which this install already accepted, so it is not offered.`,
        technicalDetail: `the manifest is stale or replayed (accepted release recorded in ${path})`,
      }
    : {
        message: `The ${ring} release manifest offers ${version}, which cannot be compared with ${mark.version}, the newest release this install accepted, so it is not offered.`,
        technicalDetail: `incomparable with the accepted release recorded in ${path}`,
      };
}

export interface ArchiveUpdateStatus {
  installKind: 'archive' | 'archive-service';
  applyMethod: ArchiveApplyMethod;
  channel: string;
  currentVersion: string;
  latestVersion?: string;
  releaseCheck: ArchiveReleaseCheck;
  updateAvailable: boolean;
  remoteUnreachable?: boolean;
  message?: string;
  technicalDetail: string | null;
  selfUpdateUnavailableReason: string | null;
  selfUpdateUnavailableCode: null;
  serviceUpdate?: ServiceUpdateProgress;
  /**
   * #3851: this server takes `stage` and `apply` requests (and the
   * apply-when-idle intent) besides the one-click update. Present only for
   * `service-update`; clients that see it offer Download, then Restart.
   */
  stagedUpdates?: true;
}

/** The newest-release check for an archive install, never an `error`. */
export async function archiveUpdateStatus(
  provenance: ArchiveProvenance,
  options: ArchiveUpdateOptions = {},
): Promise<ArchiveUpdateStatus> {
  const method = archiveApplyMethod(provenance, options.env);
  const ring = provenance.release.releaseChannel;
  const installState: ArchiveInstallState | null = provenance.installRoot
    ? readArchiveInstallState(provenance.installRoot)
    : null;
  const base = {
    installKind:
      method === 'service-update'
        ? ('archive-service' as const)
        : ('archive' as const),
    applyMethod: method,
    channel: ring,
    currentVersion: provenance.version,
    selfUpdateUnavailableCode: null,
    ...(method === 'service-update' && provenance.installRoot
      ? {
          serviceUpdate: readServiceUpdateProgress(provenance.installRoot, {
            includeStaged: options.includeStaged ?? true,
          }),
          stagedUpdates: true as const,
        }
      : {}),
  };
  let refusal: string | null =
    method === 'service-update' ? null : archiveApplyRefusal(method);

  const manifestUrl = installState?.manifestUrl ?? null;
  if (!manifestUrl) {
    return {
      ...base,
      releaseCheck: 'not-recorded',
      updateAvailable: false,
      message:
        'This install records no public release manifest, so the server cannot check for a newer release.',
      technicalDetail: null,
      selfUpdateUnavailableReason:
        refusal ??
        `this install records no public release manifest to update from; ${UPGRADE_ON_HOST}`,
    };
  }

  let payload: ReleaseManifestPayload;
  try {
    payload = await fetchVerifiedReleaseManifest(manifestUrl, ring, options);
  } catch (error) {
    const check =
      error instanceof ReleaseCheckError ? error.check : 'unreachable';
    return {
      ...base,
      releaseCheck: check,
      updateAvailable: false,
      ...(check === 'unreachable' ? { remoteUnreachable: true } : {}),
      message:
        check === 'unreachable'
          ? `Could not reach the ${ring} release manifest.`
          : `The ${ring} release manifest did not verify against Station's pinned signing keys.`,
      technicalDetail: errorMessage(error),
      selfUpdateUnavailableReason: refusal,
    };
  }

  // The installer refuses a manifest older than the newest release this
  // install root accepted (a replay after a rollback), so it is not offered
  // here either, and the operator sees why.
  const replayRefusal = provenance.installRoot
    ? acceptedReleaseRefusal(provenance.installRoot, ring, payload.version)
    : null;
  if (replayRefusal) {
    return {
      ...base,
      releaseCheck: 'unverified',
      updateAvailable: false,
      ...replayRefusal,
      selfUpdateUnavailableReason: refusal,
    };
  }

  const order = compareStationReleaseVersions(
    payload.version,
    provenance.version,
  );
  const updateAvailable = order === 1;
  if (updateAvailable && refusal === null) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const { min, max } = payload.launcherProtocol;
    if (
      !payload.artifacts.some(
        (artifact) => artifact.os === platform && artifact.arch === arch,
      )
    ) {
      refusal = `Station ${payload.version} publishes no server archive for ${platform}-${arch}`;
    } else if (
      SERVICE_LAUNCHER_PROTOCOL < min ||
      SERVICE_LAUNCHER_PROTOCOL > max
    ) {
      refusal = `Station ${payload.version} needs a newer service launcher than this service runs; ${UPGRADE_ON_HOST}, then reinstall the service with "station service install"`;
    }
  }
  return {
    ...base,
    releaseCheck: 'verified',
    latestVersion: payload.version,
    updateAvailable,
    technicalDetail: null,
    selfUpdateUnavailableReason: refusal,
  };
}

export type ArchiveApplyResult =
  | { ok: true; requestId: string; targetVersion?: string }
  | { ok: false; status: 409 | 500; error: string };

const IN_FLIGHT: ReadonlySet<ServiceUpdateProgress['state']> = new Set([
  'queued',
  'staging',
  'updating',
]);

function isServiceUpdateInFlight(progress: ServiceUpdateProgress): boolean {
  return IN_FLIGHT.has(progress.state);
}

/**
 * Queues the update request for the launcher-supervised service. Nothing is
 * downloaded here: the running version's own install.sh stages and verifies
 * the release, and the launcher trials it. Progress and the outcome are read
 * back from the runtime files (`readServiceUpdateProgress`).
 *
 * `intent` (#3851): `update` (the default, and every caller before #3851)
 * stages and trials in one request; `stage` only downloads and verifies the
 * newest release the check finds, and nothing restarts; `apply` trials the
 * version a stage left `staged`, which must be `version` when one is named
 * (the version the person confirmed), and downloads nothing.
 */
export async function applyArchiveUpdate(
  provenance: ArchiveProvenance,
  options: ArchiveUpdateOptions = {},
  request: { intent?: ServiceUpdateIntent; version?: string } = {},
): Promise<ArchiveApplyResult> {
  const intent = request.intent ?? 'update';
  const method = archiveApplyMethod(provenance, options.env);
  if (method !== 'service-update' || !provenance.installRoot) {
    const reason = archiveApplyRefusal(
      method === 'service-update' ? 'station-upgrade' : method,
    );
    return {
      ok: false,
      status: 409,
      error: `This Station server cannot update itself: ${reason}.`,
    };
  }
  if (!readArchiveInstallState(provenance.installRoot)?.manifestUrl) {
    return {
      ok: false,
      status: 409,
      error: `This install records no public release manifest to update from; ${UPGRADE_ON_HOST}.`,
    };
  }
  const progress = readServiceUpdateProgress(provenance.installRoot);
  if (isServiceUpdateInFlight(progress)) {
    return {
      ok: false,
      status: 409,
      error: 'A Station update is already in progress.',
    };
  }
  if (progress.state === 'needs-operator') {
    return {
      ok: false,
      status: 409,
      error: `The update to ${progress.targetVersion} could not be rolled back and needs an operator on the host first.`,
    };
  }
  if (intent === 'apply') {
    // The staged record is the authority: a version is applied only once a
    // stage verified it, and only the one the person was shown.
    if (progress.state !== 'staged') {
      return {
        ok: false,
        status: 409,
        error:
          'No downloaded update is ready to apply; download the update first.',
      };
    }
    if (request.version !== undefined && request.version !== progress.version) {
      return {
        ok: false,
        status: 409,
        error: `The downloaded update is ${progress.version}, not ${request.version}; check for updates again.`,
      };
    }
    return writeRequest(provenance.installRoot, progress.version, 'apply');
  }
  // The same verified check the GET reports: an apply is refused unless it
  // finds a newer release this host and this launcher can run.
  const status = await archiveUpdateStatus(provenance, options);
  if (
    status.releaseCheck !== 'verified' ||
    !status.updateAvailable ||
    status.selfUpdateUnavailableReason
  ) {
    return {
      ok: false,
      status: 409,
      error: status.selfUpdateUnavailableReason
        ? `This Station server cannot update itself: ${status.selfUpdateUnavailableReason}.`
        : status.releaseCheck === 'verified'
          ? `There is nothing to update: this server runs the newest ${status.channel} release (${status.currentVersion}).`
          : status.releaseCheck === 'unreachable'
            ? `${status.message ?? 'Could not reach the release manifest.'} Check this server's network access to it and try again, or ${UPGRADE_ON_HOST}.`
            : `${status.message ?? 'The release check did not verify.'} Nothing was requested; ${UPGRADE_ON_HOST}.`,
    };
  }
  if (intent === 'stage') {
    if (
      progress.state === 'staged' &&
      progress.version === status.latestVersion
    )
      return {
        ok: false,
        status: 409,
        error: `Station ${progress.version} is already downloaded and ready to apply.`,
      };
    // The exact version the check verified, so the stage downloads what was
    // offered even if the manifest moves meanwhile.
    return writeRequest(provenance.installRoot, status.latestVersion, 'stage');
  }
  return writeRequest(provenance.installRoot);
}

/**
 * THE apply step (#3851): restarts this server into the version a stage left
 * `staged`. Every apply goes through here (the POST route, the coordinator's
 * Restart and its apply-when-idle), so it is the one seam where a server
 * run by the process supervisor (packages/supervisor) will later hand off
 * through `requestSupervisorHandoff()` instead of writing
 * `update-request.json` for the fixed launcher. Today it only does the
 * latter. It writes the request before its first await: the coordinator's
 * apply-when-idle cancel relies on the re-read of the intent and this write
 * happening in one synchronous stretch.
 */
export function applyStagedServerUpdate(
  provenance: ArchiveProvenance,
  options: ArchiveUpdateOptions = {},
  version?: string,
): Promise<ArchiveApplyResult> {
  return applyArchiveUpdate(provenance, options, {
    intent: 'apply',
    ...(version ? { version } : {}),
  });
}

function writeRequest(
  installRoot: string,
  targetVersion?: string,
  mode?: 'stage' | 'apply',
): ArchiveApplyResult {
  try {
    const written = writeServiceUpdateRequest(installRoot, targetVersion, {
      ...(mode ? { mode } : {}),
    });
    return {
      ok: true,
      requestId: written.id,
      ...(targetVersion ? { targetVersion } : {}),
    };
  } catch (error) {
    // A request published between the check above and the write is the one
    // conflict; anything else is this server failing to write it.
    return {
      ok: false,
      status: error instanceof ServiceUpdateAlreadyRequestedError ? 409 : 500,
      error: errorMessage(error),
    };
  }
}
