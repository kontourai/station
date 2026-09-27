import { type KeyObject, sign } from 'node:crypto';

/**
 * A schema v2 (per-platform, #2675) payload in exactly the shape
 * `ecosystem-manifest.mjs assemble` writes: artifacts sorted by os, then
 * arch, and one per target.
 */
export function platformPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const version = '0.7.0-nightly.12';
  const base = `https://github.com/kontourai/station/releases/download/v${version}/`;
  const artifact = (
    os: string,
    arch: string,
    format: string,
    digit: string,
  ) => ({
    os,
    arch,
    name: `station-server-${os}-${arch}.${format}`,
    url: `${base}station-server-${os}-${arch}.${format}`,
    sha256: digit.repeat(64),
    size: 100_000_000 + Number.parseInt(digit, 16),
    format,
  });
  return {
    schemaVersion: 2,
    channel: 'nightly',
    version,
    releaseTag: `v${version}`,
    sourceSha: '0123456789abcdef0123456789abcdef01234567',
    publishedAt: '2026-09-25T00:00:00.000Z',
    nodeVersion: '24.21.0',
    launcherProtocol: { min: 1, max: 1 },
    artifacts: [
      artifact('darwin', 'arm64', 'tar.gz', '1'),
      artifact('darwin', 'x64', 'tar.gz', '2'),
      artifact('linux', 'arm64', 'tar.gz', '3'),
      artifact('linux', 'x64', 'tar.gz', '4'),
      artifact('win32', 'x64', 'zip', '5'),
    ],
    ...overrides,
  };
}

/**
 * The signed bytes, written independently of both verifiers under test: a
 * golden literal pins all of them to the same function.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Signs `payload` directly, bypassing the signer's own validation, to model a
 * pinned key that signed something every verifier must still refuse.
 */
export function signEnvelope(
  payload: unknown,
  keyId: string,
  privateKey: KeyObject,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyId,
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString('base64'),
  };
}
