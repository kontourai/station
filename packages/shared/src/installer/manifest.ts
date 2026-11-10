/**
 * Manifest verification for the Windows installer core (#2675 slice W). The
 * checks are the shared verifier's own functions (release-manifest.mjs, which
 * the signer and the service supervisor use), composed in
 * verifyReleaseManifest's order with two installer policies on top:
 *
 * - under the test-only flag, artifact URLs may be http: or file: (as in
 *   install.sh), and a test-only key may replace a pinned key's BYTES; the
 *   envelope's keyId must still be pinned and authorized for the channel;
 * - each refusal carries install.sh's exit code, so the two installers report
 *   the same failure the same way.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  assertEnvelopeShape,
  assertEnvelopeSignature,
  isHttpsArtifactUrl,
  isPlainCanonicalUrl,
  parseKeyTable,
  pinnedKeyFor,
  type ReleaseManifestPayload,
  validateReleaseManifestPayloadV2,
} from '../release-manifest.mjs';

/**
 * install.sh's verifier exit codes: 2 unknown keyId, 3 key not authorized
 * for the payload channel, 4 signature did not verify, 5 artifact URL not a
 * plain canonical URL, 6 no archive for this host, 7 launcher protocol not
 * supported, 8 signed channel is not the requested one, 1 anything else.
 */
export class ManifestRefusal extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function refusal(error: unknown, code = 1): ManifestRefusal {
  return new ManifestRefusal(
    error instanceof Error ? error.message : String(error),
    code,
  );
}

export type VerifyInstallManifestOptions = {
  /** The release ring the caller installs (stable, preview or nightly). */
  expectedChannel: string;
  /** STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1. */
  allowTestUrls: boolean;
  /** A test-only public key standing in for the pinned key's bytes. */
  testKeyPem?: string;
};

/** Verifies a parsed manifest envelope against `keys`, or throws a ManifestRefusal. */
export function verifyInstallManifest(
  envelope: unknown,
  keys: unknown,
  options: VerifyInstallManifestOptions,
): ReleaseManifestPayload {
  try {
    assertEnvelopeShape(envelope);
  } catch (error) {
    throw refusal(error);
  }
  const shaped = envelope as { keyId: string; payload: unknown };
  const table = parseKeyTable(keys);
  const channel = isObject(shaped.payload) ? shaped.payload.channel : undefined;
  let key: KeyObject;
  try {
    key = pinnedKeyFor(table, shaped.keyId, channel);
  } catch (error) {
    if (!table.has(shaped.keyId)) throw refusal(error, 2);
    throw refusal(error, typeof channel === 'string' ? 3 : 1);
  }
  if (options.testKeyPem !== undefined) {
    if (!options.allowTestUrls)
      throw new ManifestRefusal('a test-only key needs the test-only flag', 1);
    key = createPublicKey(options.testKeyPem);
  }
  try {
    assertEnvelopeSignature(
      envelope as Parameters<typeof assertEnvelopeSignature>[0],
      key,
    );
  } catch (error) {
    throw refusal(error, 4);
  }
  const payload = shaped.payload;
  if (!isObject(payload))
    throw new ManifestRefusal('manifest payload has an unexpected shape', 1);
  if (payload.schemaVersion !== 2)
    throw new ManifestRefusal('unsupported manifest schema', 1);
  let verified: ReleaseManifestPayload;
  try {
    verified = validateReleaseManifestPayloadV2(payload, {
      isAllowedArtifactUrl: options.allowTestUrls
        ? (url) => isPlainCanonicalUrl(url, ['https:', 'http:', 'file:'])
        : isHttpsArtifactUrl,
    });
  } catch (error) {
    throw refusal(
      error,
      /url is not a canonical HTTPS URL$/.test((error as Error).message)
        ? 5
        : 1,
    );
  }
  if (verified.channel !== options.expectedChannel)
    throw new ManifestRefusal(
      `manifest channel ${verified.channel} does not match the expected channel ${options.expectedChannel}`,
      8,
    );
  return verified;
}

/** install.sh's one-line summary of each verifier exit code. */
export function manifestFailureSummary(code: number, target: string): string {
  switch (code) {
    case 2:
      return 'public ecosystem manifest is signed by a key this installer does not pin';
    case 3:
      return 'public ecosystem manifest signing key is not authorized for the manifest channel';
    case 4:
      return 'public ecosystem manifest signature did not verify';
    case 5:
      return 'public ecosystem manifest artifact URL is not in canonical form';
    case 6:
      return `public ecosystem manifest publishes no server archive for this host (${target})`;
    case 7:
      return 'the release needs a newer installer: its launcher protocol is not one this installer writes';
    case 8:
      return 'requested channel does not match public ecosystem manifest';
    default:
      return 'public ecosystem manifest is invalid';
  }
}
