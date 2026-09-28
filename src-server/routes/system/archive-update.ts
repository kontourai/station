import { realpathSync } from 'node:fs';
import type { ServiceUpdateProgress } from '@kontourai/station-contracts/system-status';
import {
  type ArchiveInstallState,
  compareStationReleaseVersions,
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
  let response: Response;
  try {
    response = await (options.fetchFn ?? fetch)(manifestUrl, {
      signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
      // A redirect could leave https; the signature would still verify, but
      // the check promised the recorded URL, so none is followed.
      redirect: 'error',
    });
  } catch (error) {
    throw new ReleaseCheckError('unreachable', errorMessage(error));
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
      ? { serviceUpdate: readServiceUpdateProgress(provenance.installRoot) }
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
  | { ok: true; requestId: string }
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
 */
export async function applyArchiveUpdate(
  provenance: ArchiveProvenance,
  options: ArchiveUpdateOptions = {},
): Promise<ArchiveApplyResult> {
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
  try {
    return {
      ok: true,
      requestId: writeServiceUpdateRequest(provenance.installRoot).id,
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
