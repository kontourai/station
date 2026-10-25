/**
 * Offline Sigstore verification against real bundles (#2998).
 *
 * Fixtures are real public-good Sigstore bundles, captured unmodified with
 * `gh attestation download <file> --repo <owner/repo>` on 2026-10-24:
 * - `uv-0.13.5-…` and `uv-0.13.4-…`: SLSA provenance that astral-sh/uv's
 *   release workflow attested for `dist-manifest.json` of each release. Same
 *   workflow identity, different signing runs and certificates.
 * - `ruff-0.17.2-…`: the same for astral-sh/ruff (same owner, different
 *   repository, self-hosted runner).
 * - `cli-2.103.2-…`: a GitHub release attestation for cli/cli's checksums
 *   file, from GitHub's own Sigstore instance. It has no transparency-log
 *   entry.
 * No station-plugins repository exists yet, so these real third-party
 * workflow identities stand in as test identities. Every negative case below
 * starts from one of these bundles and changes only the field under test.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPluginSigstoreVerifier,
  createPluginSigstoreVerifierWithTrustedRootForTests,
  MAX_PLUGIN_SIGSTORE_BUNDLE_BYTES,
  type PluginSigstoreVerifier,
} from '../plugin-sigstore-verifier.js';
import embeddedTrustedRoot from '../sigstore-public-good-trusted-root.json' with {
  type: 'json',
};

type Json = Record<string, any>;

function fixture(name: string): Json {
  return JSON.parse(
    readFileSync(
      new URL(
        `../__fixtures__/sigstore/${name}.sigstore.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
}

const UV_0135 = 'uv-0.13.5-dist-manifest.slsa';
const UV_0134 = 'uv-0.13.4-dist-manifest.slsa';
const RUFF = 'ruff-0.17.2-dist-manifest.slsa';
const CLI_RELEASE = 'cli-2.103.2-checksums.release';
const DIGEST = {
  [UV_0135]:
    'sha256:138cb5269b045cb3da1caa0de6295b0a8d8d97d02377b56972a4c46f9811185d',
  [UV_0134]:
    'sha256:23827f3966eec04bdddc62eb418de9bb7dcb8dc5f3c956addc26f84dd7dfbeca',
  [RUFF]:
    'sha256:32d7fb690b8096f0940544e5191f2845b4c6499c1d1925c21810783d5418c7af',
  [CLI_RELEASE]:
    'sha256:414d6009dc7f9f936d70831af818d1a32aa0ff07a77646861efd207356a36b2d',
};

const production = createPluginSigstoreVerifier();

/** Serializes an edited fixture to the bytes the verifier actually takes. */
function overJson(target: PluginSigstoreVerifier) {
  return {
    verify: ({
      bundle,
      artifactDigest,
    }: {
      bundle: unknown;
      artifactDigest: string;
    }) =>
      target.verify({
        bundleBytes: Buffer.from(JSON.stringify(bundle)),
        artifactDigest,
      }),
  };
}
const verifier = overJson(production);

afterEach(() => {
  vi.restoreAllMocks();
});

function refuseNetwork() {
  const blocked = () => {
    throw new Error('network access during verification');
  };
  return [
    vi.spyOn(globalThis, 'fetch').mockImplementation(blocked),
    vi.spyOn(http, 'request').mockImplementation(blocked),
    vi.spyOn(http, 'get').mockImplementation(blocked),
    vi.spyOn(https, 'request').mockImplementation(blocked),
    vi.spyOn(https, 'get').mockImplementation(blocked),
    vi.spyOn(net, 'connect').mockImplementation(blocked),
    vi.spyOn(net, 'createConnection').mockImplementation(blocked),
    vi.spyOn(tls, 'connect').mockImplementation(blocked),
  ];
}

describe('real bundles verify offline against the embedded trusted root', () => {
  test('uv release provenance verifies with no network and states its workflow identity', () => {
    const spies = refuseNetwork();
    const result = verifier.verify({
      bundle: fixture(UV_0135),
      artifactDigest: DIGEST[UV_0135],
    });
    expect(result).toEqual({
      state: 'verified',
      signedAt: '2026-10-22T01:35:34.000Z',
      identity: {
        issuer: 'https://token.actions.githubusercontent.com',
        subjectAlternativeName:
          'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/heads/main',
        buildConfigUri:
          'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/heads/main',
        sourceRepositoryUri: 'https://github.com/astral-sh/uv',
        sourceRepositoryRef: 'refs/heads/main',
        repositoryId: '699532645',
        ownerId: '115962839',
        trigger: 'workflow_dispatch',
        runnerEnvironment: 'github-hosted',
      },
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test('a second release of the same workflow and a different repository both verify', () => {
    const previous = verifier.verify({
      bundle: fixture(UV_0134),
      artifactDigest: DIGEST[UV_0134],
    });
    const other = verifier.verify({
      bundle: fixture(RUFF),
      artifactDigest: DIGEST[RUFF],
    });
    expect(previous).toMatchObject({
      state: 'verified',
      signedAt: '2026-10-20T15:24:25.000Z',
      identity: { repositoryId: '699532645' },
    });
    expect(other).toMatchObject({
      state: 'verified',
      identity: {
        sourceRepositoryUri: 'https://github.com/astral-sh/ruff',
        repositoryId: '523043277',
        ownerId: '115962839',
        runnerEnvironment: 'self-hosted',
      },
    });
  });

  test('the embedded root is the trust anchor: without its Fulcio authorities the same bundle fails', () => {
    const withoutFulcio = overJson(
      createPluginSigstoreVerifierWithTrustedRootForTests({
        ...embeddedTrustedRoot,
        certificateAuthorities: [],
      }),
    );
    expect(
      withoutFulcio.verify({
        bundle: fixture(UV_0135),
        artifactDigest: DIGEST[UV_0135],
      }),
    ).toEqual({
      state: 'refused',
      reason: 'verification-failed',
      detail: 'CERTIFICATE_ERROR',
    });
  });
});

describe('refusals', () => {
  test('a tampered artifact digest is refused', () => {
    const flipped = `${DIGEST[UV_0135].slice(0, -1)}${
      DIGEST[UV_0135].endsWith('8') ? '9' : '8'
    }`;
    for (const artifactDigest of [flipped, DIGEST[RUFF]]) {
      expect(
        verifier.verify({ bundle: fixture(UV_0135), artifactDigest }),
      ).toEqual({ state: 'refused', reason: 'artifact-digest-mismatch' });
    }
  });

  test('a statement rewritten to name another digest fails verification', () => {
    const bundle = fixture(UV_0135);
    const statement = JSON.parse(
      Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'),
    );
    statement.subject[0].digest.sha256 = DIGEST[RUFF].slice('sha256:'.length);
    bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(statement),
    ).toString('base64');
    expect(
      verifier.verify({ bundle, artifactDigest: DIGEST[RUFF] }),
    ).toMatchObject({ state: 'refused', reason: 'verification-failed' });
  });

  test('a bundle without an inclusion proof is refused even though its signed entry timestamp is valid', () => {
    const bundle = fixture(UV_0135);
    delete bundle.verificationMaterial.tlogEntries[0].inclusionProof;
    expect(
      verifier.verify({ bundle, artifactDigest: DIGEST[UV_0135] }),
    ).toEqual({ state: 'refused', reason: 'missing-inclusion-proof' });
  });

  test('an inclusion proof without its signed checkpoint is refused', () => {
    const bundle = fixture(UV_0135);
    delete bundle.verificationMaterial.tlogEntries[0].inclusionProof.checkpoint;
    expect(
      verifier.verify({ bundle, artifactDigest: DIGEST[UV_0135] }),
    ).toEqual({ state: 'refused', reason: 'missing-inclusion-proof' });
  });

  test('an inclusion proof that does not verify is refused', () => {
    const bundle = fixture(UV_0135);
    const proof = bundle.verificationMaterial.tlogEntries[0].inclusionProof;
    const hash = Buffer.from(proof.hashes[0], 'base64');
    hash[0] ^= 0xff;
    proof.hashes[0] = hash.toString('base64');
    expect(
      verifier.verify({ bundle, artifactDigest: DIGEST[UV_0135] }),
    ).toEqual({
      state: 'refused',
      reason: 'verification-failed',
      detail: 'TLOG_INCLUSION_PROOF_ERROR',
    });
  });

  test('a bundle with no transparency-log entry is refused', () => {
    expect(
      verifier.verify({
        bundle: fixture(CLI_RELEASE),
        artifactDigest: DIGEST[CLI_RELEASE],
      }),
    ).toEqual({ state: 'refused', reason: 'missing-transparency-log-entry' });
    const emptied = fixture(UV_0135);
    emptied.verificationMaterial.tlogEntries = [];
    expect(
      verifier.verify({ bundle: emptied, artifactDigest: DIGEST[UV_0135] }),
    ).toEqual({ state: 'refused', reason: 'missing-transparency-log-entry' });
  });

  test('a bundle with no timestamp (no signed entry timestamp, no RFC 3161) is refused', () => {
    const bundle = fixture(UV_0135);
    delete bundle.verificationMaterial.tlogEntries[0].inclusionPromise;
    expect(
      bundle.verificationMaterial.timestampVerificationData.rfc3161Timestamps,
    ).toBeUndefined();
    expect(
      verifier.verify({ bundle, artifactDigest: DIGEST[UV_0135] }),
    ).toEqual({ state: 'refused', reason: 'no-verified-timestamp' });
  });

  test('a verified timestamp outside the certificate window is refused', () => {
    // The 0.13.4 log entry carries a genuine signed entry timestamp from two
    // days before the 0.13.5 certificate's ten-minute window opened.
    const bundle = fixture(UV_0135);
    bundle.verificationMaterial.tlogEntries =
      fixture(UV_0134).verificationMaterial.tlogEntries;
    expect(
      verifier.verify({ bundle, artifactDigest: DIGEST[UV_0135] }),
    ).toEqual({
      state: 'refused',
      reason: 'timestamp-outside-certificate-window',
    });
  });

  test('a timestamp edited into the window is not trusted: its signed entry timestamp no longer verifies', () => {
    const bundle = fixture(UV_0135);
    const entry = bundle.verificationMaterial.tlogEntries[0];
    entry.integratedTime = String(Number(entry.integratedTime) + 1);
    expect(
      verifier.verify({ bundle, artifactDigest: DIGEST[UV_0135] }),
    ).toMatchObject({ state: 'refused', reason: 'verification-failed' });
  });

  test('bundles outside the supported shape are refused before verification', () => {
    const older = fixture(UV_0135);
    older.mediaType = 'application/vnd.dev.sigstore.bundle.v0.2+json';
    const otherPayload = fixture(UV_0135);
    otherPayload.dsseEnvelope.payloadType = 'text/plain';
    for (const bundle of [older, otherPayload]) {
      expect(
        verifier.verify({ bundle, artifactDigest: DIGEST[UV_0135] }),
      ).toEqual({ state: 'refused', reason: 'unsupported-bundle' });
    }
    expect(
      verifier.verify({ bundle: {}, artifactDigest: DIGEST[UV_0135] }),
    ).toEqual({ state: 'refused', reason: 'malformed-bundle' });
  });

  test('raw bytes over the bound are refused before parsing', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const raw = Buffer.from(JSON.stringify(fixture(UV_0135)));
    parse.mockClear();
    const oversized = Buffer.concat([
      raw,
      Buffer.alloc(MAX_PLUGIN_SIGSTORE_BUNDLE_BYTES + 1 - raw.byteLength, 0x20),
    ]);
    expect(
      production.verify({
        bundleBytes: oversized,
        artifactDigest: DIGEST[UV_0135],
      }),
    ).toEqual({ state: 'refused', reason: 'bundle-too-large' });
    expect(parse).not.toHaveBeenCalled();
    // The same bundle at exactly the bound still verifies.
    expect(
      production.verify({
        bundleBytes: oversized.subarray(0, MAX_PLUGIN_SIGSTORE_BUNDLE_BYTES),
        artifactDigest: DIGEST[UV_0135],
      }),
    ).toMatchObject({ state: 'verified' });
  });

  test('bytes that are not UTF-8 JSON are malformed', () => {
    for (const bundleBytes of [
      Buffer.from('not json'),
      Buffer.from([0x7b, 0xff, 0x7d]),
    ]) {
      expect(
        production.verify({ bundleBytes, artifactDigest: DIGEST[UV_0135] }),
      ).toEqual({ state: 'refused', reason: 'malformed-bundle' });
    }
  });
});
