import type { Buffer } from 'node:buffer';
import type { BinaryLike } from 'node:crypto';

export interface CompanionBuildManifest {
  schemaVersion: 1;
  kind: 'station-telemetry-companion';
  scope: 'build-only';
  source: string;
  target: 'node24-unix';
  images: string[];
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

export const COMPANION_DEPLOYMENT_FILES: readonly string[];
export const COMPANION_FILES: readonly string[];
export function companionDigest(bytes: BinaryLike): string;
export function readCompanionFile(
  path: string,
  limit?: number,
): Promise<Buffer>;
/** Byte identity only, never release qualification or installation authority. */
export function verifyTelemetryCompanionFiles(
  directory: string,
): Promise<CompanionBuildManifest>;
