import type { KeyObject } from 'node:crypto';
import type {
  PortableServerArch,
  PortableServerFormat,
  PortableServerOs,
} from './portable-server-targets.mjs';

export type ReleaseManifestArtifact = {
  os: PortableServerOs;
  arch: PortableServerArch;
  name: string;
  url: string;
  sha256: string;
  size: number;
  format: PortableServerFormat;
};

export type ReleaseManifestPayload = {
  schemaVersion: 2;
  channel: string;
  version: string;
  releaseTag: string;
  sourceSha: string;
  publishedAt: string;
  nodeVersion: string;
  launcherProtocol: { min: number; max: number };
  artifacts: ReleaseManifestArtifact[];
};

/** config/release-manifest-keys.json's shape. */
export type ReleaseManifestKeyTable = {
  keys: ReadonlyArray<{
    keyId: string;
    algorithm: string;
    publicKeySpkiPem: string;
    channels: readonly string[];
  }>;
};

export type PinnedReleaseKeys = Map<
  string,
  { channels: string[]; key: KeyObject }
>;

export type ReleaseManifestEnvelope = {
  schemaVersion: 1;
  algorithm: 'ed25519';
  keyId: string;
  payload: unknown;
  signature: string;
};

export const SHA256_HEX: RegExp;
export const NODE_VERSION: RegExp;
export const KEY_ID: RegExp;
export const CHANNEL_VERSION: Readonly<Record<string, RegExp>>;
export function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown>;
export function canonicalManifestJson(value: unknown): string;
export function isCanonicalUrl(value: unknown): value is string;
export function isPlainCanonicalUrl(
  value: unknown,
  protocols: readonly string[],
): value is string;
export function isHttpsArtifactUrl(value: unknown): value is string;
export function parseKeyTable(table: unknown): PinnedReleaseKeys;
export function assertEnvelopeShape(envelope: unknown): ReleaseManifestEnvelope;
export function pinnedKeyFor(
  keys: PinnedReleaseKeys,
  keyId: string,
  channel: unknown,
): KeyObject;
export function assertEnvelopeSignature(
  envelope: ReleaseManifestEnvelope,
  key: KeyObject,
): void;
export function validateCommonPayload(payload: Record<string, unknown>): void;
export function validateReleaseManifestPayloadV2(
  payload: unknown,
  policy: { isAllowedArtifactUrl: (url: unknown) => boolean },
): ReleaseManifestPayload;
export function verifyReleaseManifest(
  envelope: unknown,
  keys: ReleaseManifestKeyTable | unknown,
  options: { expectedChannel: string },
): ReleaseManifestPayload;
export function selectArtifact(
  payload: ReleaseManifestPayload,
  os: string,
  arch: string,
): ReleaseManifestArtifact;
