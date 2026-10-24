import { join } from 'node:path';
import type { TelemetryCompanionArtifactEvidence } from '@kontourai/station-contracts/telemetry-delivery';
import {
  type ReleaseManifestArtifact,
  type ReleaseManifestKeyTable,
  type ReleaseManifestPayload,
  selectArtifact,
  verifyReleaseManifest,
} from '@kontourai/station-shared/release-manifest';
import PINNED_KEYS from '../../config/release-manifest-keys.json' with {
  type: 'json',
};
import type { InstallProvenance } from '../routes/system/install-provenance.js';
import {
  readCompanionFile,
  verifyTelemetryCompanionFiles,
} from './telemetry-companion-artifact.mjs';

/** Reads evidence only. The original archive bytes and runtime qualification remain separate. */
export async function readTelemetryCompanionArtifactEvidence(
  provenance: InstallProvenance,
  {
    keys = PINNED_KEYS,
    platform = process.platform,
    arch = process.arch,
  }: {
    keys?: ReleaseManifestKeyTable;
    platform?: string;
    arch?: string;
  } = {},
): Promise<TelemetryCompanionArtifactEvidence> {
  if (provenance.installKind !== 'archive' || !provenance.installRoot)
    return { kind: 'unavailable', reason: 'archive-install-required' };
  let envelope: unknown;
  try {
    envelope = JSON.parse(
      (
        await readCompanionFile(
          join(provenance.archiveRoot, '.station-signed-release-manifest.json'),
          1024 * 1024,
        )
      ).toString(),
    );
  } catch (error) {
    return {
      kind: 'unavailable',
      reason:
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'release-envelope-missing'
          : 'release-envelope-invalid',
    };
  }
  let release: ReleaseManifestPayload;
  let artifact: ReleaseManifestArtifact;
  try {
    release = verifyReleaseManifest(envelope, keys, {
      expectedChannel: provenance.release.releaseChannel,
    });
    if (
      release.sourceSha !== provenance.release.sha ||
      release.version !== provenance.version
    )
      return { kind: 'unavailable', reason: 'release-envelope-invalid' };
    artifact = selectArtifact(release, platform, arch);
  } catch {
    return { kind: 'unavailable', reason: 'release-envelope-invalid' };
  }
  try {
    const manifest = await verifyTelemetryCompanionFiles(
      join(provenance.archiveRoot, 'telemetry-companion'),
    );
    if (manifest.source !== release.sourceSha)
      return { kind: 'unavailable', reason: 'companion-payload-invalid' };
  } catch {
    return { kind: 'unavailable', reason: 'companion-payload-invalid' };
  }
  return {
    kind: 'parent-envelope-verified',
    version: release.version,
    source: release.sourceSha,
    artifactSha256: artifact.sha256,
    qualification: 'build-only',
    installationAuthority: false,
  };
}
